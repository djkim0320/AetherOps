package schedule

import (
	"testing"
	"time"
)

func TestScheduleParsing(t *testing.T) {
	if _, err := Parse(Spec{Kind: "every", Expression: "59s"}); err == nil {
		t.Fatal("sub-minute schedules must be rejected")
	}
	parsed, err := Parse(Spec{Kind: "cron", Expression: "0 9 * * 1-5", Timezone: "Asia/Seoul"})
	if err != nil {
		t.Fatal(err)
	}
	next := parsed.Next(time.Date(2026, 8, 6, 0, 0, 0, 0, time.UTC))
	if next.Location().String() != "Asia/Seoul" {
		t.Fatalf("unexpected timezone %s", next.Location())
	}
}

func TestCoalesceMissed(t *testing.T) {
	now := time.Date(2026, 8, 6, 12, 0, 0, 0, time.UTC)
	got, ok := CoalesceMissed(now, []time.Time{
		now.Add(-48 * time.Hour),
		now.Add(-2 * time.Hour),
		now.Add(-time.Hour),
	})
	if !ok || !got.Equal(now.Add(-time.Hour)) {
		t.Fatalf("unexpected coalesced time %s", got)
	}
}

func TestCronSkipsNonexistentDSTWallClock(t *testing.T) {
	parsed, err := Parse(Spec{Kind: "cron", Expression: "30 2 * * *", Timezone: "America/New_York"})
	if err != nil {
		t.Fatal(err)
	}
	location, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	after := time.Date(2026, 3, 8, 1, 59, 0, 0, location)
	next := parsed.Next(after)
	if next.Day() != 9 || next.Hour() != 2 || next.Minute() != 30 {
		t.Fatalf("nonexistent DST time was not skipped deterministically: %s", next)
	}
}

func TestCronEnumeratesBothAutumnDSTWallClockOccurrences(t *testing.T) {
	parsed, err := Parse(Spec{Kind: "cron", Expression: "30 1 * * *", Timezone: "America/New_York"})
	if err != nil {
		t.Fatal(err)
	}
	location, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}

	first := parsed.Next(time.Date(2026, 11, 1, 0, 0, 0, 0, location))
	second := parsed.Next(first)
	wantFirst := time.Date(2026, 11, 1, 5, 30, 0, 0, time.UTC)
	wantSecond := time.Date(2026, 11, 1, 6, 30, 0, 0, time.UTC)
	if !first.Equal(wantFirst) || !second.Equal(wantSecond) {
		t.Fatalf("repeated DST occurrences = %s, %s; want %s, %s", first, second, wantFirst, wantSecond)
	}
	if first.In(location).Format("2006-01-02 15:04") != "2026-11-01 01:30" ||
		second.In(location).Format("2006-01-02 15:04") != "2026-11-01 01:30" {
		t.Fatalf("occurrences do not share the repeated wall clock: %s, %s", first, second)
	}
	_, firstOffset := first.In(location).Zone()
	_, secondOffset := second.In(location).Zone()
	if firstOffset != -4*60*60 || secondOffset != -5*60*60 {
		t.Fatalf("repeated DST offsets = %d, %d", firstOffset, secondOffset)
	}
}
