# Self-hosted frontend overrides

This image extends the selected official frontend with the sidebar styles and
existing login-defaults helper. It does not compile the ClojureScript application
or change the backend, database, accounts, or design files.

The self-host entrypoint appends the native `disable-onboarding` flag before
calling the original `/entrypoint.sh`. It preserves all other deployment flags
and the original command. First-login survey and team-setup dialogs no longer
open. The native flag also disables automatic release-note dialogs; manual team
creation and normal dashboard actions remain available. No profile properties
are rewritten to simulate a completed survey.

Existing login-defaults configuration remains separate: the helper only fills
empty login fields and does not submit the form. Real credentials must stay in
protected runtime secrets, never in this directory or image.

Run the entrypoint checks without installing dependencies:

```sh
bash -n frontend/selfhost/entrypoint.sh
node --test frontend/selfhost/entrypoint.test.mjs
```

Build this directory using the deployment's existing pinned official frontend
base. Keep its version and digest when this is the only change; upgrading the
full frontend or backend is a separate task.

The image copies public scripts, styles, and nginx configuration with mode 0644.
This keeps them readable by the unprivileged runtime user even when Git was
checked out under a restrictive umask. Credentials remain runtime secrets.
