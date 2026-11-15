package main

import (
	"strings"
	"testing"
)

func TestWaitingPage(t *testing.T) {
	html := waitingPage("Mingle <is> starting", "Show Logs & retry")
	for _, want := range []string{"Mingle &lt;is&gt; starting", "Show Logs &amp; retry", `class="hint"`, `role="status"`} {
		if !strings.Contains(html, want) {
			t.Errorf("waiting page lacks %q", want)
		}
	}
	// LoadHTML takes the document as it is: no URL escaping may leak into it.
	for _, leak := range []string{"%0A", "%23", "%25"} {
		if strings.Contains(html, leak) {
			t.Errorf("waiting page contains %q", leak)
		}
	}
	if strings.Contains(waitingPage("Starting", ""), `class="hint"`) {
		t.Error("a page without a hint shows one")
	}
}

func TestWaitingTextsAreUserFacing(t *testing.T) {
	for _, tx := range []texts{zhTexts(), enTexts()} {
		if tx.starting == "" || tx.restarting == "" || tx.restartHint == "" {
			t.Errorf("missing waiting page text: %+v", tx)
		}
	}
}
