// Package migrations holds embedded SQL migration files for the Rylo server.
package migrations

import "embed"

// FS holds all migration SQL files embedded at compile time.
//
//go:embed *.sql
var FS embed.FS
