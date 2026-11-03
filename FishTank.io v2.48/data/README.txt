Player accounts are saved here as accounts.json (passwords are salted+hashed).
On Render, add a Persistent Disk mounted at /opt/render/project/src/data or accounts reset on every redeploy.
Never upload accounts.json to GitHub.
