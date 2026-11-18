package engine

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

// dials the endpoint and retries after a disconnect
func connect(ctx context.Context, c Config, j *journal, commands chan<- request) {
	delay := time.Second

	for ctx.Err() == nil {
		header := http.Header{}
		if c.Token != "" {
			header.Set("Authorization", "Bearer "+c.Token)
		}

		conn, _, err := websocket.Dial(ctx, c.URL, &websocket.DialOptions{HTTPHeader: header})
		if err == nil {
			delay = time.Second
			err = serve(ctx, conn, j, commands)
		}

		if ctx.Err() != nil {
			return
		}
		log.Printf("endpoint disconnected (%T), retrying in %s", err, delay)

		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}

		delay = min(delay*2, 30*time.Second)
	}
}

// handles commands and streams journal events over one WebSocket connection
func serve(parent context.Context, conn *websocket.Conn, j *journal, commands chan<- request) error {
	ctx, cancel := context.WithCancel(parent)

	defer conn.CloseNow()
	defer cancel()

	conn.SetReadLimit(4 << 20) // 4 MiB

	// start at the most recent event
	// a replay command always can move this connection's cursor to an earlier event
	cursor := j.next()

	// we read commands in a separate goroutine so the socket cannot stall event delivery
	inbox := make(chan []byte)
	go func() {
		defer cancel()
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			select {
			case inbox <- data:
			case <-ctx.Done():
				return
			}
		}
	}()

	// all replies and events share one writer with a deadline (15s) for slow connections
	write := func(data []byte) error {
		deadline, stop := context.WithTimeout(ctx, 15*time.Second)
		defer stop()
		return conn.Write(deadline, websocket.MessageText, data)
	}

	alwaysReady := make(chan struct{})
	close(alwaysReady)

	for {
		// when caught up, wait for the next append.
		// while behind, the closed channel makes the
		// next event immediately selectable alongside commands.
		ready := j.wake
		if cursor < j.next() {
			ready = alwaysReady
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case data := <-inbox:
			var c command
			reply := object{}
			if err := json.Unmarshal(data, &c); err != nil || c.ID == "" {
				reply = object{"id": c.ID, "error": "expected a JSON command with a string id"}
			} else if c.Op == "replay" {
				// the next unwritten sequence is valid
				// the reader will wait there for a new event
				if c.From < 1 || c.From > j.next() {
					reply = object{"id": c.ID, "error": "from outside log range"}
				} else {
					cursor = c.From
					reply = object{"id": c.ID, "result": nil}
				}
			} else {
				// the buffered reply lets the session finish the command even if this connection drops
				req := request{c, make(chan object, 1)}
				select {
				case commands <- req:
				case <-ctx.Done():
					return ctx.Err()
				}
				select {
				case reply = <-req.reply:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			encoded, err := json.Marshal(reply)
			if err != nil {
				return err
			}
			if err = write(encoded); err != nil {
				return err
			}
			continue
		case <-ready:
		}

		// send one event per iteration so incoming commands can be handled during replay
		data, err := j.read(cursor)
		if err != nil {
			return err
		}
		if data != nil {
			if err = write(data); err != nil {
				return err
			}
			cursor++
		}
	}
}
