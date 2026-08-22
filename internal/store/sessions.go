package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/id"
)

var (
	ErrConversationSessionBusy            = errors.New("conversation session has active or recoverable research work")
	ErrConversationSessionScheduled       = errors.New("conversation session has an enabled schedule")
	ErrLastConversationSession            = errors.New("a project must keep at least one conversation session")
	ErrConversationSessionCreationUnknown = errors.New("conversation session thread creation outcome is unknown")
)

func normalizeSessionTitle(title string) (string, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		title = "새 대화"
	}
	if !utf8.ValidString(title) || strings.ContainsRune(title, utf8.RuneError) || utf8.RuneCountInString(title) > 80 {
		return "", errors.New("conversation session title must be valid undamaged UTF-8 no longer than 80 characters")
	}
	return title, nil
}

func (db *DB) CreateConversationSession(
	ctx context.Context,
	projectID, title string,
	configuration core.RunConfiguration,
) (core.ConversationSession, error) {
	title, err := normalizeSessionTitle(title)
	if err != nil {
		return core.ConversationSession{}, err
	}
	sessionID, err := id.New("ses")
	if err != nil {
		return core.ConversationSession{}, err
	}
	now := time.Now().UTC()
	session := core.ConversationSession{
		ID: sessionID, ProjectID: projectID, Title: title,
		Status: "unprovisioned",
		Model:  configuration.Model, ReasoningEffort: configuration.ReasoningEffort,
		ServiceTier: configuration.ServiceTier, ContextProfile: configuration.NormalizedContextProfile(),
		CreatedAt: now, UpdatedAt: now,
	}
	_, err = db.sql.ExecContext(ctx, `
INSERT INTO conversation_sessions(
  id, project_id, title, codex_thread_id, status, revision, model, reasoning_effort,
  service_tier, context_profile, created_at, updated_at, deleted_at
) VALUES(?, ?, ?, '', 'unprovisioned', 0, ?, ?, ?, ?, ?, ?, NULL)`,
		session.ID, session.ProjectID, session.Title, session.Model,
		session.ReasoningEffort, session.ServiceTier, session.ContextProfile, formatTime(now), formatTime(now))
	return session, err
}

func (db *DB) ListConversationSessions(ctx context.Context, projectID string) ([]core.ConversationSession, error) {
	rows, err := db.sql.QueryContext(ctx, conversationSessionSelect+`
 WHERE project_id = ? AND deleted_at IS NULL
 ORDER BY updated_at DESC, created_at DESC, id`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var sessions []core.ConversationSession
	for rows.Next() {
		session, err := scanConversationSession(rows)
		if err != nil {
			return nil, err
		}
		sessions = append(sessions, session)
	}
	return sessions, rows.Err()
}

func (db *DB) ConversationSession(ctx context.Context, sessionID string) (core.ConversationSession, error) {
	return scanConversationSession(db.sql.QueryRowContext(ctx,
		conversationSessionSelect+" WHERE id = ? AND deleted_at IS NULL", sessionID))
}

func (db *DB) DefaultConversationSession(ctx context.Context, projectID string) (core.ConversationSession, error) {
	return scanConversationSession(db.sql.QueryRowContext(ctx, conversationSessionSelect+`
 WHERE project_id = ? AND deleted_at IS NULL
 ORDER BY created_at, id LIMIT 1`, projectID))
}

func (db *DB) RenameConversationSession(ctx context.Context, sessionID, title string) (core.ConversationSession, error) {
	title, err := normalizeSessionTitle(title)
	if err != nil {
		return core.ConversationSession{}, err
	}
	result, err := db.sql.ExecContext(ctx, `
UPDATE conversation_sessions SET title = ?, revision = revision + 1, updated_at = ?
WHERE id = ? AND deleted_at IS NULL`, title, formatTime(time.Now()), sessionID)
	if err != nil {
		return core.ConversationSession{}, err
	}
	if count, err := result.RowsAffected(); err != nil {
		return core.ConversationSession{}, err
	} else if count != 1 {
		return core.ConversationSession{}, sql.ErrNoRows
	}
	return db.ConversationSession(ctx, sessionID)
}

func (db *DB) UpdateConversationSessionSettings(
	ctx context.Context,
	sessionID string,
	configuration core.RunConfiguration,
) error {
	result, err := db.sql.ExecContext(ctx, `
UPDATE conversation_sessions
SET model = ?, reasoning_effort = ?, service_tier = ?, context_profile = ?, revision = revision + 1, updated_at = ?
WHERE id = ? AND deleted_at IS NULL`, configuration.Model,
		configuration.ReasoningEffort, configuration.ServiceTier,
		configuration.NormalizedContextProfile(), formatTime(time.Now()), sessionID)
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil {
		return err
	} else if count != 1 {
		return sql.ErrNoRows
	}
	return nil
}

func (db *DB) MarkConversationSessionProvisioning(ctx context.Context, sessionID string) (core.ConversationSession, error) {
	result, err := db.sql.ExecContext(ctx, `
UPDATE conversation_sessions
SET status = 'provisioning', revision = revision + 1, updated_at = ?
WHERE id = ? AND deleted_at IS NULL AND status = 'unprovisioned'`,
		formatTime(time.Now()), sessionID)
	if err != nil {
		return core.ConversationSession{}, err
	}
	if count, err := result.RowsAffected(); err != nil {
		return core.ConversationSession{}, err
	} else if count != 1 {
		session, lookupErr := db.ConversationSession(ctx, sessionID)
		if lookupErr != nil {
			return core.ConversationSession{}, lookupErr
		}
		if session.Status == "creation_unknown" || session.Status == "provisioning" {
			return core.ConversationSession{}, ErrConversationSessionCreationUnknown
		}
		return core.ConversationSession{}, errors.New("conversation session cannot start thread provisioning")
	}
	return db.ConversationSession(ctx, sessionID)
}

func (db *DB) MarkConversationSessionCreationUnknown(ctx context.Context, sessionID string) error {
	_, err := db.sql.ExecContext(ctx, `
UPDATE conversation_sessions
SET status = 'creation_unknown', revision = revision + 1, updated_at = ?
WHERE id = ? AND deleted_at IS NULL AND status = 'provisioning'`,
		formatTime(time.Now()), sessionID)
	return err
}

func (db *DB) SetConversationSessionThreadIfEmpty(ctx context.Context, sessionID, threadID string) (string, error) {
	if strings.TrimSpace(threadID) == "" {
		return "", errors.New("Codex thread id is empty")
	}
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer transaction.Rollback()
	now := formatTime(time.Now())
	if _, err := transaction.ExecContext(ctx, `
UPDATE conversation_sessions
SET codex_thread_id = ?, status = 'active', revision = revision + 1, updated_at = ?
WHERE id = ? AND codex_thread_id = '' AND status = 'provisioning' AND deleted_at IS NULL`, threadID, now, sessionID); err != nil {
		return "", err
	}
	var actual, projectID string
	if err := transaction.QueryRowContext(ctx, `
SELECT codex_thread_id, project_id FROM conversation_sessions
WHERE id = ? AND deleted_at IS NULL`, sessionID).Scan(&actual, &projectID); err != nil {
		return "", err
	}
	if actual == "" {
		return "", ErrConversationSessionCreationUnknown
	}
	// Preserve the legacy project field as a mirror of the oldest active
	// session only. New code never treats it as the session authority.
	if _, err := transaction.ExecContext(ctx, `
UPDATE projects SET main_thread_id = ?, updated_at = ?
WHERE id = ? AND main_thread_id = '' AND ? = (
  SELECT id FROM conversation_sessions
  WHERE project_id = ? AND deleted_at IS NULL
  ORDER BY created_at, id LIMIT 1
)`, actual, now, projectID, sessionID, projectID); err != nil {
		return "", err
	}
	if err := transaction.Commit(); err != nil {
		return "", err
	}
	return actual, nil
}

// DeleteConversationSession removes a session from the active UI without
// deleting its Codex thread or historical run references. Recoverable work and
// enabled schedules make the operation unsafe and are rejected.
func (db *DB) DeleteConversationSession(ctx context.Context, sessionID string) error {
	transaction, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	var projectID string
	if err := transaction.QueryRowContext(ctx, `
SELECT project_id FROM conversation_sessions
WHERE id = ? AND deleted_at IS NULL`, sessionID).Scan(&projectID); err != nil {
		return err
	}
	var activeRuns int
	if err := transaction.QueryRowContext(ctx, `
SELECT COUNT(*) FROM runs
WHERE conversation_session_id = ? AND status IN (
  'queued','planning','collecting','synthesizing','reviewing','revising',
  'waiting_approval','interrupted','uncertain'
)`, sessionID).Scan(&activeRuns); err != nil {
		return err
	}
	if activeRuns != 0 {
		return ErrConversationSessionBusy
	}
	var enabledSchedules int
	if err := transaction.QueryRowContext(ctx, `
SELECT COUNT(*) FROM schedules
WHERE conversation_session_id = ? AND enabled = 1`, sessionID).Scan(&enabledSchedules); err != nil {
		return err
	}
	if enabledSchedules != 0 {
		return ErrConversationSessionScheduled
	}
	var activeSessions int
	if err := transaction.QueryRowContext(ctx, `
SELECT COUNT(*) FROM conversation_sessions
WHERE project_id = ? AND deleted_at IS NULL`, projectID).Scan(&activeSessions); err != nil {
		return err
	}
	if activeSessions <= 1 {
		return ErrLastConversationSession
	}
	now := formatTime(time.Now())
	if _, err := transaction.ExecContext(ctx, `
UPDATE conversation_sessions SET deleted_at = ?, revision = revision + 1, updated_at = ?
WHERE id = ? AND deleted_at IS NULL`, now, now, sessionID); err != nil {
		return err
	}
	var replacementThread string
	if err := transaction.QueryRowContext(ctx, `
SELECT codex_thread_id FROM conversation_sessions
WHERE project_id = ? AND deleted_at IS NULL
ORDER BY created_at, id LIMIT 1`, projectID).Scan(&replacementThread); err != nil {
		return err
	}
	if _, err := transaction.ExecContext(ctx, `
UPDATE projects SET main_thread_id = ?, updated_at = ? WHERE id = ?`,
		replacementThread, now, projectID); err != nil {
		return err
	}
	return transaction.Commit()
}

const conversationSessionSelect = `
SELECT id, project_id, title, codex_thread_id, status, revision, model, reasoning_effort,
       service_tier, context_profile, created_at, updated_at
FROM conversation_sessions`

func scanConversationSession(row scanner) (core.ConversationSession, error) {
	var session core.ConversationSession
	var created, updated string
	if err := row.Scan(&session.ID, &session.ProjectID, &session.Title,
		&session.CodexThreadID, &session.Status, &session.Revision,
		&session.Model, &session.ReasoningEffort,
		&session.ServiceTier, &session.ContextProfile, &created, &updated); err != nil {
		return core.ConversationSession{}, err
	}
	var err error
	session.CreatedAt, err = parseTime(created)
	if err != nil {
		return core.ConversationSession{}, err
	}
	session.UpdatedAt, err = parseTime(updated)
	return session, err
}
