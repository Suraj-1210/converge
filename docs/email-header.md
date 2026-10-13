# Transactional email header — Collegepond logo

Every transactional email is rendered by `renderHtml()` in
`src/server/email/templates.ts` and delivered by Amazon SES, so the header is
defined once there and applies to all templates.

## Asset

| File | Served at | Pixels | Displays at | Size |
|---|---|---|---|---|
| `public/email/collegepond-logo-white.png` | `https://portal.convergeapp.co/email/collegepond-logo-white.png` | 400 × 72 (2x) | **200 × 36** | 8.9 KB |

- Pure white (#FFFFFF) on transparent, exported from the official master logo.
  Flush left in the canvas; ratio preserved (5.50 : 1).
- `LOGO_URL` points at production for every environment, so staging and dev
  emails load the same file.
- **Never rename or move the file.** Sent emails reference this URL forever.
  To change the logo, add a new file name and update `LOGO_URL`.

## Header bar

- Colour `HEADER_BG` = **#0C7BFE**, Collegepond primary blue from the brand
  guidelines. The brand rules forbid a black background behind the logo.
- Buttons keep `BRAND` (#1570EF): white 15px text on #0C7BFE is 4.0 : 1, below
  WCAG AA for small text. The logo is a large graphic, so 4.0 : 1 is fine there.
- 80 px tall: 36 px logo + 22 px padding top and bottom, 32 px left padding to
  line up with the body text.

## Email-client notes

- The `width`/`height` attributes are for Outlook desktop, which ignores CSS
  sizing. `height:auto` + `max-width` keep the ratio wherever a client scales.
- The `bgcolor` attribute and inline `background` cover Outlook and everyone else.
- Alt text is styled white and bold, so with images blocked the bar still
  reads "Collegepond".
- Dark mode: clients don't invert images, and the blue bar stays dark enough
  for white text in Gmail, Outlook and Apple Mail.
