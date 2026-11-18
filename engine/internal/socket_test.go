package engine

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

func TestReplayFollowsEventsAppendedWhileDisconnected(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "events")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	j := &journal{file: f, wake: make(chan struct{}, 1)}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		_ = serve(ctx, conn, j, nil)
	}))
	defer srv.Close()
	dial := func() *websocket.Conn {
		t.Helper()
		conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
		if err != nil {
			t.Fatal(err)
		}
		return conn
	}
	appendEvent := func() {
		t.Helper()
		if err := j.append(json.RawMessage(`{"method":"example"}`)); err != nil {
			t.Fatal(err)
		}
	}
	replay := func(conn *websocket.Conn, from int) {
		t.Helper()
		if err := wsjson.Write(ctx, conn, command{ID: "r", Op: "replay", From: from}); err != nil {
			t.Fatal(err)
		}
		var reply struct{ ID, Error string }
		if err := wsjson.Read(ctx, conn, &reply); err != nil || reply.ID != "r" || reply.Error != "" {
			t.Fatalf("replay reply %+v: %v", reply, err)
		}
	}
	expect := func(conn *websocket.Conn, seq int) {
		t.Helper()
		var event struct{ Seq int }
		if err := wsjson.Read(ctx, conn, &event); err != nil || event.Seq != seq {
			t.Fatalf("want sequence %d, got %d: %v", seq, event.Seq, err)
		}
	}
	first := dial()
	replay(first, 1)
	appendEvent()
	expect(first, 1)
	first.CloseNow()
	appendEvent()
	second := dial()
	defer second.CloseNow()
	replay(second, 2)
	appendEvent()
	expect(second, 2)
	expect(second, 3)
}
