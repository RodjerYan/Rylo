package db

import "fmt"

const (
	profileIDPrefix     = "RY"
	profileIDModulo     = 1_000_000
	profileIDMultiplier = 736_879
	profileIDOffset     = 104_729
)

// FormatProfileID converts an internal numeric user ID into a stable public
// profile ID in the form RYXXXXXX. The affine transform keeps identifiers
// deterministic while avoiding obvious registration-order sequencing.
func FormatProfileID(userID int64) string {
	normalized := userID
	if normalized < 0 {
		normalized = -normalized
	}

	value := ((normalized * profileIDMultiplier) + profileIDOffset) % profileIDModulo
	if value < 0 {
		value += profileIDModulo
	}

	return fmt.Sprintf("%s%06d", profileIDPrefix, value)
}
