# Transactional email header — Collegepond logo

The email HTML lives in MSG91's template editor, not in this repo. This file is
the source of truth for the header block pasted into each Converge template.

## Asset

| File | Served at | Pixels | Displays at | Size |
|---|---|---|---|---|
| `public/email/collegepond-logo-white.png` | `https://portal.convergeapp.co/email/collegepond-logo-white.png` | 400 × 72 (2x) | **200 × 36** | 8.9 KB |

- Pure white (#FFFFFF) on transparent, exported from the official master logo.
  Logo is flush left in the canvas; ratio preserved (5.50 : 1).
- Do not rename or move the file: sent emails reference this URL forever.
  To change the logo, add a new file name and update the templates.

## Header bar

- Colour: Collegepond primary blue **#0C7BFE**. White-on-blue contrast is 4.0 : 1
  (passes WCAG 3 : 1 for graphics). Brand rules forbid a black background.
  Alternative: navy **#0F2851** (14.6 : 1) — replace both `#0C7BFE` values.
- Height: 80 px (36 px logo + 22 px padding top and bottom).
- Left padding 32 px — match it to the template body's left padding so the logo
  lines up with the text below.

## Snippet

Paste as the first row inside the template's 600 px content container.

```html
<!-- Collegepond header (docs/email-header.md) -->
<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="#0C7BFE" style="width:100%;background-color:#0C7BFE;border-collapse:collapse;">
  <tr>
    <td align="left" valign="middle" bgcolor="#0C7BFE" style="padding:22px 32px;background-color:#0C7BFE;text-align:left;">
      <img src="https://portal.convergeapp.co/email/collegepond-logo-white.png" width="200" height="36" alt="Collegepond" border="0" style="display:block;border:0;outline:none;text-decoration:none;width:200px;max-width:200px;height:auto;color:#FFFFFF;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:bold;line-height:36px;" />
    </td>
  </tr>
</table>
```

Why it is built this way:

- `width`/`height` attributes: Outlook desktop ignores CSS sizing.
- `height:auto` + `max-width`: other clients keep the ratio if they shrink it.
- `bgcolor` and inline `background-color`: Outlook reads the attribute, others
  the style.
- Alt text is styled white so the bar still reads "Collegepond" when images are
  blocked.
- Dark mode: the PNG is never inverted, and the blue bar stays dark enough for
  white in Gmail, Outlook and Apple Mail dark modes.

## Applying it in MSG91

1. Confirm the image is live: open the URL above in a browser.
2. control.msg91.com → **Email → Templates**. Only edit Converge templates —
   `scholarship_email_otp` and `scholarpath_emailotp` belong to ScholarPath.
3. Open the template → **Edit**. In the HTML/code view, find the existing top
   bar or logo (or the top of the content container) and replace it with the
   snippet. In the drag-and-drop editor, add a custom HTML block at the top and
   paste the snippet there.
4. Save. Check the template ID didn't change; it must still match the
   `MSG91_*_TEMPLATE_ID` env var in App Platform.
5. Send a test to your own inbox and check Gmail web, Outlook desktop and
   Apple Mail / iPhone, in light and dark mode.
