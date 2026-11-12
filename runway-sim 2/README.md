# Airport Runway Digital Twin - audience simulation

A 20-minute multiplayer simulation for the session "Data Quality and Noise Handling in
Digital Twins and IoT". Up to 8 runway control rooms of up to 6 people each watch noisy
sensor dashboards and decide whether aircraft can land or take off.

## Run it

Needs Node.js 18 or newer. No packages to install.

    node server.js

- Participants open  `http://<host>:3000/`
- Presenter opens    `http://<host>:3000/admin`  (project this screen)
- Admin key: `runway2026` by default. Set your own with the `ADMIN_KEY` environment variable.

## Free hosting (Render)

1. Put this folder in a GitHub repository.
2. On render.com: New > Web Service > connect the repository.
3. Build command: leave empty (or `npm install`). Start command: `node server.js`. Instance type: Free.
4. Add an environment variable `ADMIN_KEY` with your own secret.
5. Open the site about two minutes before the session: a free instance sleeps after
   15 idle minutes and takes about a minute to wake up.

The game state lives in the server's memory, so every device shares it. If the service
restarts, registrations may be lost.

## How a session runs

1. Participants type a name and pick a free role. Rooms 1-4 are open first; room 5 opens
   when rooms 1-4 are full, and so on up to room 8.
2. The presenter presses **Start**. Only the admin tab moves the clock: if it is closed the
   simulation pauses and continues when it is reopened.
3. The first aircraft calls after 30 seconds. Landings and take-offs alternate. With more
   rooms, aircraft arrive closer together (20-60 seconds apart).
4. Each call is open for 60 seconds. The server picks one runway at random among the rooms
   that answered READY and are free. The landing or take-off is decided 60 seconds later
   (120 seconds after the call) from the *real* runway condition, not from the sensors.
5. If the room transmits GO-AROUND, a landing aircraft calls MAYDAY to the other rooms. The
   first free room to accept gets it and it lands 45 seconds later.
6. After 20 minutes the session ends and the admin screen shows the real conditions and how
   often each room's sensor picture matched reality.

**Reset game** clears outcomes and keeps registrations. **Clear registrations** removes everyone.
**Reveal truth** shows the real runway state and the faulty sensors on the projector.

## Roles

| Role | Controls |
|---|---|
| ATC Controller | Runway READY / Decline for each aircraft call |
| Sensor Monitor | Cross-check a sensor against a reference instrument (8 s) |
| Data Quality Analyst | Smoothing filter per sensor; flag a sensor as faulty |
| Maintenance Engineer | Recalibrate a sensor (12 s); inspect, de-ice, plough, sweep, repair lights |
| Weather Officer | Manual weather observation (10 s) |
| Communicator | Go-around / abort take-off; ask for a pilot report |

The server only accepts an action from the participant who holds that role in that room.
If a role is unfilled in a room, its controls are open to everyone in that room.

## Noise model

Each runway has a hidden real state (weather, visibility, surface, crosswind, objects,
lights) and eight sensors that report it with noise. Faults are injected at random:

- random spikes (removed by the smoothing filter)
- false alarm: bias, lens contamination, camera glare, radar ghost target (fixed by recalibration)
- under-reading that hides a real hazard (fixed by recalibration)
- stuck / frozen value (fixed by recalibration)
- data dropout (recovers by itself)

During about a third of approaches a critical warning appears: sometimes a real hazard,
more often a false alarm.

## Scoring

| Event | Points |
|---|---|
| Safe landing or take-off | +10 |
| Safe emergency (MAYDAY) landing | +20 |
| Correct abort / go-around (runway really was unsafe) | +10 |
| Wrong abort (runway was safe) | -5 |
| Declined or ignored a call while the runway was safe | -5 |
| Accident | -20, runway blocked 40 s |

All timings, points and probabilities are constants at the top of `engine.js`.
