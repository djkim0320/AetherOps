package schedule

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/store"
)

const maxOccurrencesPerTick = 10000

type Clock interface {
	Now() time.Time
}

type SystemClock struct{}

func (SystemClock) Now() time.Time { return time.Now() }

type Service struct {
	DB    *store.DB
	Clock Clock

	// maxOccurrences is test-controlled so long-downtime batching can be
	// exercised without inserting thousands of SQLite audit rows. Production
	// callers leave it zero and use maxOccurrencesPerTick.
	maxOccurrences int
}

func (service *Service) Create(ctx context.Context, schedule core.Schedule) (core.Schedule, error) {
	if service.DB == nil {
		return core.Schedule{}, errors.New("scheduler database is not configured")
	}
	parsed, err := Parse(Spec{Kind: schedule.Kind, Expression: schedule.Expression, Timezone: schedule.Timezone})
	if err != nil {
		return core.Schedule{}, err
	}
	now := service.now()
	next := parsed.Next(now)
	if next.IsZero() {
		return core.Schedule{}, errors.New("schedule has no future occurrence")
	}
	schedule.Enabled = true
	schedule.NextRunAt = &next
	return service.DB.CreateSchedule(ctx, schedule)
}

func (service *Service) Tick(ctx context.Context) error {
	if service.DB == nil {
		return errors.New("scheduler database is not configured")
	}
	now := service.now()
	due, err := service.DB.ListDueSchedules(ctx, now)
	if err != nil {
		return err
	}
	var failures []error
	for _, item := range due {
		if err := service.process(ctx, now, item); err != nil {
			failures = append(failures, fmt.Errorf("schedule %s: %w", item.ID, err))
		}
	}
	return errors.Join(failures...)
}

func (service *Service) process(ctx context.Context, now time.Time, item core.Schedule) error {
	if item.NextRunAt == nil {
		return nil
	}
	parsed, err := Parse(Spec{Kind: item.Kind, Expression: item.Expression, Timezone: item.Timezone})
	if err != nil {
		return err
	}
	occurrences := make([]time.Time, 0, 8)
	cursor := *item.NextRunAt
	moreDue := false
	limit := service.occurrenceLimit()
	for !cursor.After(now) {
		occurrences = append(occurrences, cursor)
		next := parsed.Next(cursor)
		if next.IsZero() || !next.After(cursor) {
			cursor = time.Time{}
			break
		}
		cursor = next
		if len(occurrences) >= limit && !cursor.After(now) {
			// Persist bounded progress instead of permanently failing on the same
			// overdue cursor. Recent occurrences in an intermediate page are
			// intentionally left coalesced; the final page owns the one queued run.
			moreDue = true
			break
		}
	}
	if len(occurrences) == 0 {
		return nil
	}
	cutoff := now.Add(-24 * time.Hour)
	for _, occurrence := range occurrences {
		if occurrence.Before(cutoff) {
			if _, err := service.DB.RecordMissedSchedule(ctx, item.ID, occurrence); err != nil {
				return err
			}
		}
	}
	if !moreDue {
		latest, shouldRun := CoalesceMissed(now, occurrences)
		if shouldRun {
			if _, _, err := service.DB.CreateScheduledRun(ctx, item, latest); err != nil {
				return err
			}
		}
	}
	last := occurrences[len(occurrences)-1]
	var nextPointer *time.Time
	if !cursor.IsZero() {
		nextPointer = &cursor
	}
	return service.DB.UpdateScheduleTimes(ctx, item.ID, *item.NextRunAt, &last, nextPointer)
}

func (service *Service) occurrenceLimit() int {
	if service.maxOccurrences > 0 && service.maxOccurrences < maxOccurrencesPerTick {
		return service.maxOccurrences
	}
	return maxOccurrencesPerTick
}

func (service *Service) now() time.Time {
	if service.Clock == nil {
		return time.Now().UTC()
	}
	return service.Clock.Now().UTC()
}
