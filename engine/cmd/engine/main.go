package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/ca-lee-b/juno/engine/internal"
)

func main() {
	var c engine.Config

	flag.StringVar(&c.URL, "endpoint", os.Getenv("ENGINE_ENDPOINT"), "WebSocket endpoint")
	flag.StringVar(&c.Codex, "codex", "codex", "Codex executable")
	flag.StringVar(&c.Dir, "dir", ".", "Codex working directory")
	flag.Parse()

	c.Token = os.Getenv("ENGINE_TOKEN")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := engine.Run(ctx, c); err != nil {
		log.Fatal(err)
	}
}
