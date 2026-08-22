package id

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
)

func New(prefix string) (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	if prefix == "" {
		return hex.EncodeToString(bytes[:]), nil
	}
	return fmt.Sprintf("%s_%s", prefix, hex.EncodeToString(bytes[:])), nil
}
