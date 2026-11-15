package main

import (
	"log"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

// pageState is what the window shows: the waiting page until Mingle answers, then
// its console. It remembers which, so a page whose web content process died is
// shown again instead of leaving the window blank.
type pageState struct {
	page *mygo.Page
	// base is where the waiting page sits: on the console's own site, so opening the
	// console is a same-site navigation that keeps the web content process.
	base string

	mu   sync.Mutex
	show func()
	// reloaded is when a gone process last had its page shown again.
	reloaded time.Time
}

// reloadPause keeps a page that keeps crashing its process from reloading in a loop.
const reloadPause = 10 * time.Second

func newPageState(page *mygo.Page, origin string) *pageState {
	p := &pageState{page: page, base: origin + "/starting"}
	page.OnRenderProcessGone(func(reason string) {
		log.Println("window: web content process gone:", reason)
		p.mu.Lock()
		wait := max(0, reloadPause-time.Since(p.reloaded))
		p.reloaded = time.Now().Add(wait)
		p.mu.Unlock()
		// Whatever the window should show by then: Mingle may have restarted meanwhile.
		time.AfterFunc(wait, func() {
			p.mu.Lock()
			show := p.show
			p.mu.Unlock()
			if show != nil {
				show()
			}
		})
	})
	return p
}

// waiting shows the waiting page with what Mingle is doing and, if any, a hint.
func (p *pageState) waiting(text, hint string) {
	html := waitingPage(text, hint)
	p.set(func() { p.page.LoadHTML(html, p.base) })
}

// console shows the console of the Mingle answering at url.
func (p *pageState) console(url, token string) {
	p.set(func() { _ = p.page.LoadURL(url + "/#token=" + token) })
}

func (p *pageState) set(show func()) {
	p.mu.Lock()
	p.show = show
	p.mu.Unlock()
	show()
}

// waitingPage is shown until the console answers. It is the console's look
// (DESIGN.md): the brand, a spinner and one line saying what Mingle is doing, on
// the page colour, in the system's appearance. Plain HTML, loaded with LoadHTML:
// it needs no network and no escaping beyond the text.
func waitingPage(text, hint string) string {
	var b strings.Builder
	b.WriteString(`<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>
:root{--bg:#fff;--ink2:#5b5b64;--ink3:#8a8a93;--line2:#d9d9e0;--ring:transparent}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1f;--ink2:#b3b3bc;--ink3:#85858f;--line2:#404047;--ring:rgba(255,255,255,.2)}}
html,body{height:100%;margin:0}
html{--app-region:drag;-webkit-app-region:drag;cursor:default;-webkit-user-select:none;user-select:none}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:var(--bg);color:var(--ink2);
font:13px/18px -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased}
svg.mark{width:48px;height:48px;border-radius:12px;box-shadow:0 0 0 1px var(--ring)}
.status{display:flex;align-items:center;gap:8px}
.spin{width:12px;height:12px;box-sizing:border-box;border-radius:50%;border:1.5px solid var(--line2);border-top-color:var(--ink3);animation:spin .9s linear infinite}
.hint{max-width:400px;margin:0;padding:0 24px;text-align:center;text-wrap:balance;font-size:12px;line-height:16px;color:var(--ink3)}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}
</style></head><body>`)
	b.WriteString(markSVG)
	b.WriteString(`<div class="status" role="status"><span class="spin" aria-hidden="true"></span><span>`)
	b.WriteString(escape(text))
	b.WriteString(`</span></div>`)
	if hint != "" {
		b.WriteString(`<p class="hint">`)
		b.WriteString(escape(hint))
		b.WriteString(`</p>`)
	}
	b.WriteString(`</body></html>`)
	return b.String()
}

// markSVG is the console's icon (web/src/icon.svg).
const markSVG = `<svg class="mark" viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" rx="24" fill="#1a1a1a"/><g fill="none" stroke="#fff" stroke-width="6.9"><circle cx="38.1" cy="50" r="21.25"/><circle cx="61.9" cy="50" r="21.25"/></g></svg>`

func escape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}
