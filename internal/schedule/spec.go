package schedule

import (
	"errors"
	"fmt"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/robfig/cron/v3"
)

type Spec struct {
	Kind       string
	Expression string
	Timezone   string
}

type Parsed interface {
	Next(time.Time) time.Time
}

type onceSchedule struct {
	at time.Time
}

func (schedule onceSchedule) Next(after time.Time) time.Time {
	if schedule.at.After(after) {
		return schedule.at
	}
	return time.Time{}
}

type everySchedule struct {
	duration time.Duration
}

func (schedule everySchedule) Next(after time.Time) time.Time {
	return after.Add(schedule.duration)
}

func Parse(spec Spec) (Parsed, error) {
	switch spec.Kind {
	case "at":
		at, err := time.Parse(time.RFC3339, spec.Expression)
		if err != nil {
			return nil, fmt.Errorf("parse at schedule: %w", err)
		}
		return onceSchedule{at: at}, nil
	case "every":
		duration, err := time.ParseDuration(spec.Expression)
		if err != nil {
			return nil, fmt.Errorf("parse every schedule: %w", err)
		}
		if duration < time.Minute {
			return nil, errors.New("every schedule must be at least one minute")
		}
		return everySchedule{duration: duration}, nil
	case "cron":
		if len(strings.Fields(spec.Expression)) != 5 {
			return nil, errors.New("cron schedule must contain exactly five fields")
		}
		timezone := spec.Timezone
		if timezone == "" {
			timezone = "UTC"
		}
		location, err := time.LoadLocation(timezone)
		if err != nil {
			return nil, fmt.Errorf("load cron timezone: %w", err)
		}
		parser := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)
		parsed, err := parser.Parse(spec.Expression)
		if err != nil {
			return nil, fmt.Errorf("parse cron schedule: %w", err)
		}
		return cronSchedule{schedule: parsed, location: location}, nil
	default:
		return nil, fmt.Errorf("unsupported schedule kind %q", spec.Kind)
	}
}

type cronSchedule struct {
	schedule cron.Schedule
	location *time.Location
}

func (schedule cronSchedule) Next(after time.Time) time.Time {
	return schedule.schedule.Next(after.In(schedule.location))
}

func CoalesceMissed(now time.Time, missed []time.Time) (time.Time, bool) {
	cutoff := now.Add(-24 * time.Hour)
	var newest time.Time
	for _, candidate := range missed {
		if candidate.Before(cutoff) || candidate.After(now) {
			continue
		}
		if newest.IsZero() || candidate.After(newest) {
			newest = candidate
		}
	}
	return newest, !newest.IsZero()
}
