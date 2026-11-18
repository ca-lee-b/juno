package engine

import (
	"encoding/json"
	"os"
	"sync"
)

// only offsets live in memory, payloads stay in the sandbox's temporary file
type journal struct {
	mu      sync.Mutex
	file    *os.File
	offsets []int64
	end     int64
	wake    chan struct{}
}

// assigns a sequence number, writes the event to disk, and wakes the reader
func (j *journal) append(event json.RawMessage) error {
	j.mu.Lock()
	defer j.mu.Unlock()

	data, err := json.Marshal(struct {
		Seq   int             `json:"seq"`
		Event json.RawMessage `json:"event"`
	}{len(j.offsets) + 1, event})
	if err != nil {
		return err
	}

	data = append(data, '\n')
	if _, err = j.file.Write(data); err != nil {
		return err
	}

	j.offsets = append(j.offsets, j.end)
	j.end += int64(len(data))

	select {
	case j.wake <- struct{}{}:
	default:
	}

	return nil
}

// simply returns the sequence number the next event will receive
// mainly used for the cursor
func (j *journal) next() int {
	j.mu.Lock()
	defer j.mu.Unlock()

	return len(j.offsets) + 1
}

// loads one event by sequence number, returning nil if it has yet to arrive
func (j *journal) read(seq int) ([]byte, error) {
	j.mu.Lock()

	// out of range
	if seq > len(j.offsets) {
		j.mu.Unlock()
		return nil, nil
	}

	start, end := j.offsets[seq-1], j.end
	if seq < len(j.offsets) {
		end = j.offsets[seq]
	}

	j.mu.Unlock()

	data := make([]byte, end-start)
	_, err := j.file.ReadAt(data, start)
	return data, err
}
