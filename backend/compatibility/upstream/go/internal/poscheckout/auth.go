package poscheckout

import (
	"crypto/sha256"
	"crypto/subtle"
)

// The app key is independent of the source customer JWT. Comparing fixed-size
// digests avoids credential-content timing differences and never logs a key.
func ProjectionKeyValid(expected, provided string) bool {
	if len(expected) < 32 || len(expected) > 4096 || len(provided) > 4096 {
		return false
	}
	left, right := sha256.Sum256([]byte(expected)), sha256.Sum256([]byte(provided))
	return subtle.ConstantTimeCompare(left[:], right[:]) == 1
}
