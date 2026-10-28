FishTank.io  (build v2.19 folder, game version 0.26.0)

  server.js       the game server (Express + ws), serves the public folder
  package.json    run "npm install" once, then "npm start"
  PROMPT.md       full notes on how everything works
  public/
    index.html    the whole client
    faces/        secret helmet faces
    music/        menu and match tracks
    vote/         map and mode pictures for the vote screen

Run locally:  npm install  then  npm start  then open http://localhost:3000
Deploy: push this folder's contents to GitHub (server.js and package.json must be at the repo root next to public/), then point Render at it.
