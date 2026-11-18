package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

type object = map[string]any

type command struct {
	ID        string          `json:"id"`
	Op        string          `json:"op"`
	Text      string          `json:"text"`
	TurnID    string          `json:"turnId"`
	RequestID json.RawMessage `json:"requestId"`
	Result    json.RawMessage `json:"result"`
	From      int             `json:"from"`
}
type request struct {
	command
	reply chan object
}
type frame struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
}
type incoming struct {
	raw json.RawMessage
	err error
}

// one goroutine owns Codex state and consumes stdout in protocol order
type session struct {
	ctx                     context.Context
	stdin                   *json.Encoder
	stdout                  <-chan incoming
	log                     *journal
	thread, turn, completed string
	stopping                bool
	pending                 map[string]bool
	serial                  int
	fatal                   error
}

// waits for the next Codex frame or session cancellation
func (s *session) receive() (frame, error) {
	select {
	case <-s.ctx.Done():
		return frame{}, s.ctx.Err()
	case in := <-s.stdout:
		return s.decode(in)
	}
}

// parses a Codex frame, logs events, and tracks active turns and pending requests
func (s *session) decode(in incoming) (frame, error) {
	var f frame
	if in.err != nil {
		return f, in.err
	}

	if err := json.Unmarshal(in.raw, &f); err != nil {
		return f, err
	}

	if f.Method == "" {
		return f, nil
	}

	if err := s.log.append(in.raw); err != nil {
		return f, err
	}

	if len(f.ID) > 0 {
		s.pending[string(f.ID)] = true
	}

	var p struct {
		ThreadID  string
		Turn      struct{ ID string }
		RequestID json.RawMessage
	}
	if f.Method == "turn/started" || f.Method == "turn/completed" || f.Method == "serverRequest/resolved" {
		if err := json.Unmarshal(f.Params, &p); err != nil {
			return f, err
		}

		if f.Method == "serverRequest/resolved" {
			delete(s.pending, string(p.RequestID))
		}

		if p.ThreadID == s.thread {
			if f.Method == "turn/started" {
				s.turn = p.Turn.ID
			}
			if f.Method == "turn/completed" {
				s.completed = p.Turn.ID
				if s.turn == p.Turn.ID {
					s.turn = ""
				}
			}
		}
	}

	return f, nil
}

// helper to send one JSON message to Codex over stdin
func (s *session) write(v object) error {
	if err := s.stdin.Encode(v); err != nil {
		s.fatal = err
		return err
	}
	return nil
}

// sends a Codex request and processes events until its reply arrives
func (s *session) call(method string, params object) (json.RawMessage, error) {
	s.serial++
	id := fmt.Sprint(s.serial)
	if err := s.write(object{"id": s.serial, "method": method, "params": params}); err != nil {
		return nil, err
	}

	for {
		f, err := s.receive()
		if err != nil {
			s.fatal = err
			return nil, err
		}
		if f.Method != "" {
			continue
		}
		if string(f.ID) != id {
			s.fatal = fmt.Errorf("unexpected Codex response ID %s", f.ID)
			return nil, s.fatal
		}
		if f.Error != nil {
			return nil, errors.New(f.Error.Message)
		}
		return f.Result, nil
	}
}

// executes one endpoint command against the current session
func (s *session) handle(c command) (any, error) {
	switch c.Op {
	case "prepare_shutdown":
		if s.turn != "" || len(s.pending) > 0 {
			return nil, errors.New("busy")
		}

		s.stopping = true
		return "ready_to_stop", nil
	case "send", "steer":
		if s.stopping {
			return nil, errors.New("stopping")
		}

		if strings.TrimSpace(c.Text) == "" {
			return nil, errors.New("text required")
		}

		input := []object{{"type": "text", "text": c.Text, "text_elements": []string{}}}

		if c.Op == "steer" {
			if c.TurnID == "" || c.TurnID != s.turn {
				return nil, errors.New("turn is not active")
			}
			return s.call("turn/steer", object{"threadId": s.thread, "expectedTurnId": c.TurnID, "input": input})
		}

		if s.turn != "" {
			return nil, errors.New("busy")
		}

		if s.thread == "" {
			raw, err := s.call("thread/start", object{})
			if err != nil {
				return nil, err
			}

			var r struct{ Thread struct{ ID string } }
			if json.Unmarshal(raw, &r) != nil || r.Thread.ID == "" {
				return nil, errors.New("missing Codex thread ID")
			}

			s.thread = r.Thread.ID
		}
		raw, err := s.call("turn/start", object{"threadId": s.thread, "input": input})
		if err != nil {
			return nil, err
		}

		var r struct{ Turn struct{ ID string } }
		if json.Unmarshal(raw, &r) != nil || r.Turn.ID == "" {
			return nil, errors.New("missing Codex turn ID")
		}

		if s.completed != r.Turn.ID {
			s.turn = r.Turn.ID
		}

		return object{"turnId": r.Turn.ID, "threadId": s.thread}, nil
	case "interrupt":
		if c.TurnID == "" || c.TurnID != s.turn {
			return nil, errors.New("turn is not active")
		}

		return s.call("turn/interrupt", object{"threadId": s.thread, "turnId": s.turn})
	case "respond":
		id := string(c.RequestID)
		if !s.pending[id] {
			return nil, errors.New("unknown request ID")
		}

		if len(c.Result) == 0 {
			return nil, errors.New("result required")
		}

		if err := s.write(object{"id": c.RequestID, "result": c.Result}); err != nil {
			return nil, err
		}

		delete(s.pending, id)
		return nil, nil
	default:
		return nil, errors.New("unknown command")
	}
}

// initializes the Codex protocol and processes commands and events in order
func (s *session) run(commands <-chan request) error {
	if _, err := s.call("initialize", object{"clientInfo": object{"name": "sandbox-engine", "version": "1"}, "capabilities": object{"experimentalApi": true}}); err != nil {
		return err
	}

	if err := s.write(object{"method": "initialized"}); err != nil {
		return err
	}

	for {
		select {
		case <-s.ctx.Done():
			return s.ctx.Err()
		case in := <-s.stdout:
			if _, err := s.decode(in); err != nil {
				return err
			}
		case req := <-commands:
			result, err := s.handle(req.command)
			reply := object{"id": req.ID, "result": result}
			if err != nil {
				reply = object{"id": req.ID, "error": err.Error()}
			}

			req.reply <- reply
			if s.fatal != nil {
				return s.fatal
			}
		}
	}
}

// reads JSON messages from Codex stdout and passes them to the session
func readCodex(ctx context.Context, r io.Reader, out chan<- incoming) {
	dec := json.NewDecoder(r)
	for {
		var raw json.RawMessage
		err := dec.Decode(&raw)
		select {
		case out <- incoming{raw, err}:
		case <-ctx.Done():
			return
		}
		if err != nil {
			return
		}
	}
}
