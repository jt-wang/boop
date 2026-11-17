// A local process boundary for release-script tests. Never calls Apple or Xcode.
package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	args := os.Args[1:]
	log, err := os.OpenFile(os.Getenv("FAKE_LOG"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil { panic(err) }
	json.NewEncoder(log).Encode(args)
	log.Close()
	if fail := os.Getenv("FAKE_FAIL"); fail != "" && strings.Contains(strings.Join(args, " "), fail) { os.Exit(19) }
	if filepath.Base(os.Args[0]) == "xcodebuild" {
		for i, arg := range args {
			if arg == "-archivePath" && i+1 < len(args) {
				app := filepath.Join(args[i+1], "Products/Applications/DeepSeekBot.app")
				os.MkdirAll(app, 0700)
				os.WriteFile(filepath.Join(app, "DeepSeekBot"), []byte("synthetic binary\x00"), 0600)
			}
		}
	}
}
