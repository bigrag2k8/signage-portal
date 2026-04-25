# ══════════════════════════════════════════════════════════
#  SIGNAGE PORTAL — Complete Setup Guide
#  For Yodeck Reseller Partners
# ══════════════════════════════════════════════════════════

This guide walks you through everything from zero to a live,
working client portal. No technical experience required.

────────────────────────────────────────────────────────────
WHAT THIS APP DOES
────────────────────────────────────────────────────────────

Your clients log in to YOUR branded portal → drop their design
file → pick their screen(s) → hit Publish. That's it. Content
goes live on their Yodeck player within seconds.

You manage everything from an admin panel:
  • Add/remove clients
  • Set each client's Yodeck API token
  • Control which screens each client can publish to
  • See a live log of every publish

────────────────────────────────────────────────────────────
STEP 1 — GET YOUR YODECK API TOKENS (one per client)
────────────────────────────────────────────────────────────

As a Yodeck Reseller you manage your clients' accounts through
your Partner Admin Console (Yconsole).

For EACH client account you want to connect:

  1. Log into your Yodeck Partner Console
  2. Switch into the client's account
  3. Go to: Settings → Advanced Settings → API Tokens
  4. Click "Generate Token"
  5. Copy the token — you'll paste it into the admin panel

Keep each client's token somewhere safe (a password manager
is ideal). You'll enter them one at a time in the admin panel.

────────────────────────────────────────────────────────────
STEP 2 — SET UP GMAIL FOR EMAIL NOTIFICATIONS
────────────────────────────────────────────────────────────

The app sends you an email every time a client publishes.
It also sends clients a welcome email when you add them.

To get a Gmail App Password:

  1. Go to: myaccount.google.com
  2. Click "Security" in the left menu
  3. Under "How you sign in to Google", click "2-Step Verification"
     (enable it if not already on)
  4. Scroll to the bottom → click "App passwords"
  5. Select app: "Mail" → Select device: "Other" → type "Signage Portal"
  6. Click "Generate"
  7. Copy the 16-character password shown (e.g. abcd efgh ijkl mnop)
     → remove the spaces when you use it: abcdefghijklmnop

────────────────────────────────────────────────────────────
STEP 3 — DEPLOY TO RAILWAY (free to start)
────────────────────────────────────────────────────────────

Railway hosts your app on the internet. Free tier is fine to
start; upgrade later if you need more resources.

  1. Create a free account at: railway.app
  2. Create a free account at: github.com (if you don't have one)
  3. Upload your app files to a new GitHub repository:
       a. Go to github.com → click "+" → "New repository"
       b. Name it "signage-portal" → click "Create repository"
       c. Upload all the files from this ZIP by dragging them
          into the GitHub repository page

  4. In Railway:
       a. Click "New Project"
       b. Choose "Deploy from GitHub repo"
       c. Select your "signage-portal" repository
       d. Railway will detect it's a Node.js app automatically

  5. Set your Environment Variables in Railway:
       a. Click on your project → click "Variables"
       b. Add each variable from the list below:

  ┌─────────────────────┬────────────────────────────────────────┐
  │ Variable Name       │ Your Value                             │
  ├─────────────────────┼────────────────────────────────────────┤
  │ ADMIN_USERNAME      │ Choose a username (e.g. admin)         │
  │ ADMIN_PASSWORD      │ Choose a strong password               │
  │ SESSION_SECRET      │ Any long random text (30+ characters)  │
  │ SMTP_USER           │ your-gmail@gmail.com                   │
  │ SMTP_PASS           │ Your Gmail App Password (no spaces)    │
  │ NOTIFY_EMAIL        │ Email to receive publish notifications │
  │ COMPANY_NAME        │ Your company name                      │
  └─────────────────────┴────────────────────────────────────────┘

  6. Railway will automatically deploy the app.
     You'll get a URL like: https://signage-portal-xyz.railway.app

  7. Visit your URL — the client login page should appear!

────────────────────────────────────────────────────────────
STEP 4 — ADD YOUR FIRST CLIENT
────────────────────────────────────────────────────────────

  1. Go to: https://your-app-url.railway.app/admin/login
  2. Sign in with your ADMIN_USERNAME and ADMIN_PASSWORD
  3. Click "Add Client"
  4. Fill in:
       • Full Name:     Client's company name
       • Email:         Client's email (they'll get a welcome email)
       • Username:      They'll use this to log in
       • Password:      Set a temporary password for them
       • Yodeck Token:  Paste the token you got in Step 1
       • Screen IDs:    (Optional) Leave blank to show all screens,
                        or paste specific screen IDs separated by commas
  5. Click "Verify" next to the token to confirm it works
  6. Click "Save Client"

The client gets an automatic welcome email with their login details!

────────────────────────────────────────────────────────────
STEP 5 — SHARE THE PORTAL WITH YOUR CLIENT
────────────────────────────────────────────────────────────

Send your client:
  • Portal URL:  https://your-app-url.railway.app/login
  • Username:    (what you set)
  • Password:    (what you set — tell them to change it)

That's it! They can now:
  1. Log in to the portal
  2. Drag and drop their design file
  3. Click their screen(s)
  4. Hit "Publish to Screens"

You'll get an email notification every time they publish.

────────────────────────────────────────────────────────────
CUSTOMIZING YOUR BRANDING
────────────────────────────────────────────────────────────

To add your company name and colors:

  1. Open public/login.html, public/portal.html, public/admin.html
  2. Find "Signage Portal" and replace with your company name
  3. The accent color is #6366f1 (indigo/purple) — find and replace
     with your brand color (e.g. #e63946 for red, #2563eb for blue)
  4. To add your logo: add an <img> tag in the .logo-area section

────────────────────────────────────────────────────────────
FINDING YODECK SCREEN IDs
────────────────────────────────────────────────────────────

If you want to restrict a client to specific screens:

  Option A — From the portal:
    Add the client without screen IDs first. Log in as that client.
    The screen cards will show all their screens. Note the names,
    then ask Yodeck support for the IDs, or:

  Option B — Via the API:
    Use a tool like Postman or curl:
      curl -H "Authorization: Api-Key YOUR_TOKEN" \
           https://app.yodeck.com/api/v1/monitor/
    The "id" field for each result is the screen ID.

────────────────────────────────────────────────────────────
TROUBLESHOOTING
────────────────────────────────────────────────────────────

"No screens found"
  → The Yodeck token is missing or wrong. Edit the client in
    admin and re-paste/verify the token.

"Publish failed"
  → Check that the client's Yodeck account is on Premium or
    Enterprise (required for API access).

Emails not sending
  → Double-check your Gmail App Password has no spaces.
    Make sure 2-Step Verification is enabled on your Gmail.

App won't start on Railway
  → Check the Railway logs (click your project → Deployments).
    Most common cause: a missing environment variable.

────────────────────────────────────────────────────────────
SUPPORT
────────────────────────────────────────────────────────────

Yodeck API docs:  https://app.yodeck.com/api-docs/
Yodeck Partner:   https://www.yodeck.com/docs/user-manual/partner/
Railway docs:     https://docs.railway.app
Gmail App Passwords: https://support.google.com/accounts/answer/185833

══════════════════════════════════════════════════════════
