# Smart Logistics — Frontend

React 19 single-page application for the courier dashboard. Connects to the Gateway via WebSocket for real-time telemetry and AI route recommendations, and renders a live Leaflet map alongside a delivery manifest sidebar.

---

## Tech Stack

| Library | Version | Role |
|---|---|---|
| React | 19.2 | UI framework |
| Vite | 8.0 | Dev server and build tool |
| react-router-dom | 7 | Client-side routing |
| Zustand | 5 | Global state management |
| Leaflet + react-leaflet | 1.9 / 5.0 | Interactive map rendering |
| lucide-react | latest | Icon set |

---

## Folder Structure

```
frontend/
├── src/
│   ├── pages/
│   │   ├── LoginPage.jsx          # Courier authentication form
│   │   ├── LoginPage.css
│   │   ├── CourierDashboard.jsx   # Main layout: map + sidebar + action cards
│   │   └── CourierDashboard.css
│   ├── components/
│   │   ├── MapLayer.jsx           # Leaflet map — vehicles, stops, routes
│   │   ├── MapLayer.css
│   │   ├── ActionCard.jsx         # AI recommendation alert card (Approve/Refuse)
│   │   ├── ActionCard.css
│   │   ├── DeliveryList.jsx       # Sorted container of DeliveryItem cards
│   │   ├── DeliveryList.css
│   │   ├── DeliveryItem.jsx       # Single delivery stop card with status, address, phone
│   │   ├── DeliveryItem.css
│   │   ├── ProfileHeader.jsx      # Courier photo + name in sidebar
│   │   ├── ProfileHeader.css
│   │   └── ErrorBoundary.jsx      # React error fallback UI
│   ├── hooks/
│   │   └── useTelemetry.js        # WebSocket lifecycle, message routing
│   ├── store/
│   │   └── useCourierStore.js     # Zustand store — all shared state and actions
│   ├── App.jsx                    # Router + ProtectedRoute guard
│   ├── main.jsx                   # React entry point (BrowserRouter)
│   ├── index.css                  # Global reset and base styles
│   └── App.css
├── routes.json                    # Pre-computed Sivas GPS waypoints (mainRoute / detourRoute)
├── index.html
├── vite.config.js
├── package.json
├── Dockerfile
└── .dockerignore
```

---

## Pages and Routing

Defined in [src/App.jsx](src/App.jsx):

| Path | Component | Guard |
|---|---|---|
| `/login` | `LoginPage` | Public |
| `/courier` | `CourierDashboard` | `ProtectedRoute` — redirects to `/login` if not authenticated |
| `*` | — | Redirects to `/login` |

`ProtectedRoute` checks `isAuthenticated` and `user` from the Zustand store. If either is falsy, the user is sent back to `/login`.

---

## Component Reference

### `LoginPage`
Courier authentication form. Submits email + password to `useCourierStore.login()`, which calls `POST /login` on the Gateway. On success, stores the JWT in `localStorage` and navigates to `/courier`.

---

### `CourierDashboard`
Main operational hub. Rendered after login.

- Renders `MapLayer` as the full-screen background.
- Left panel: `ActionCard` stack for pending AI recommendations (hidden on break).
- Right sidebar: `ProfileHeader`, `DeliveryList`, break toggle, logout button.
- On WebSocket connect, sends `GET_DAILY_MANIFEST` to load today's stops.
- Break mode: pauses telemetry interactions, dims sidebar, shows overlay.
- Uses `useTelemetry` hook for the WebSocket connection; passes `sendMessage` down to `ActionCard`.

---

### `MapLayer`
Interactive Leaflet map using the dark CARTO tile layer (centered on Sivas, Turkey).

**Renders:**
- **Delivery stop pins** — red SVG map pin per stop; grey + semi-transparent when the stop id is in `completedDeliveryIds`.
- **Vehicle markers** — colored circle per vehicle: green (`on-time`), amber (`reroute`), red (`critical`), grey (`offline`).
- **Active route polyline** — blue line from `vehicle.currentRoute`, colored by vehicle status.
- **Proposed route overlay** — red dashed polyline rendered when a recommendation card is hovered, sourced from `hoveredRec.route_geojson`.

Custom icons are built with `L.divIcon` (inline SVG, no external image files). A 10-second `setInterval` forces re-renders for the "ghosting" (auto-dimming stale vehicle dots) logic.

---

### `ActionCard`
Displays a single AI route recommendation from the Brain.

- Shows severity badge, reason text, and impact metrics (route health, estimated time saved).
- Live countdown timer (updates every second) if a time-window constraint is at risk.
- **Approve**: sends `APPROVE_ROUTE` → card transitions `Syncing...` → `Applied` → auto-removes after 3 s.
- **Refuse**: sends `REFUSE_ROUTE` → card removed immediately.
- **Send Email** (critical severity only): sends `SEND_EMAIL` → card shows `Sent`.
- Hovering sets `hoveredRecommendationId` → `MapLayer` renders the proposed route as a dashed overlay.

---

### `DeliveryList`
Container for all delivery stop cards. Sorts deliveries by `time` (earliest window first) and passes `isActive` / `isCompleted` props to each `DeliveryItem`.

---

### `DeliveryItem`
Single delivery row. Visual states:

| State | Badge | Icon | Style |
|---|---|---|---|
| Pending | `NORMAL` / `WARNING` / `CRITICAL` | Clock | Color-coded border |
| Active | `EN ROUTE` | Spinning Navigation | Blue glow |
| Completed | `COMPLETED` | CheckCircle | Greyed, dimmed text |

Shows: time window, destination name, street address (resolved from PostGIS via Gateway), clickable phone number (hidden when completed), AI route confirmation badge.

---

### `ProfileHeader`
Courier name and profile photo in the sidebar. Click the photo area to upload an image — reads as a base64 DataURL and persists it via `updateProfileImage`.

---

### `ErrorBoundary`
Catches any uncaught React rendering error and displays a "Critical Subsystem Failure" fallback with a reload button.

---

## State Management

Single Zustand store at [src/store/useCourierStore.js](src/store/useCourierStore.js).

### State Shape

| Key | Type | Description |
|---|---|---|
| `vehicles` | `Vehicle[]` | Live courier positions from `VEHICLE_TELEMETRY` |
| `activeRoutes` | `GeoJSON[]` | Current blue route line from `ACTIVE_ROUTE_UPDATE` |
| `pendingRecommendations` | `Recommendation[]` | AI action cards from `AI_ROUTE_RECOMMENDATION` |
| `hoveredRecommendationId` | `string \| null` | ID of hovered card — triggers map route overlay |
| `isOnBreak` | `boolean` | Break mode toggle |
| `user` | `{ id, name, email, vehicleType, profileImage }` | Logged-in courier |
| `isAuthenticated` | `boolean` | Guards route access |
| `deliveries` | `Delivery[]` | Today's stops from `DAILY_MANIFEST_LOADED` |
| `activeDeliveryId` | `string \| null` | Currently active stop |
| `completedDeliveryIds` | `string[]` | Stops greyed out after `DELIVERY_COMPLETED` |

### Actions

| Action | Effect |
|---|---|
| `login(email, password)` | POST to Gateway, stores JWT, sets `user` + `isAuthenticated` |
| `logout()` | Clears JWT from localStorage, resets auth state |
| `updateVehicleTelemetry(data)` | Upserts vehicle in `vehicles` array, stamps `lastPingTimestamp` |
| `addRecommendation(payload)` | Replaces any existing card for same vehicle; re-sorts `deliveries` if `new_sequence` provided |
| `setRecommendationSyncing(id)` | Sets card status to `'Syncing...'` |
| `confirmRecommendationSync(id, status)` | Sets card to `'Applied'` or `'Sent'`; `'removed'` deletes it |
| `removeRecommendation(id)` | Removes card from `pendingRecommendations` |
| `setActiveRoutes(routes)` | Replaces `activeRoutes` |
| `setHoveredRecommendation(id)` | Triggers dashed route overlay on map |
| `toggleBreak()` | Flips `isOnBreak` |
| `setDeliveries(deliveries)` | Populates stop list from manifest |
| `markDeliveryCompleted(id)` | Adds to `completedDeliveryIds`, clears `activeDeliveryId` if matched |
| `updateProfileImage(dataUrl)` | Sets base64 profile photo on `user` |
| `updateUser(data)` | Merges partial user data |

---

## WebSocket Hook — `useTelemetry`

[src/hooks/useTelemetry.js](src/hooks/useTelemetry.js) manages the entire WebSocket lifecycle.

**Connection:** Connects to `ws://<GATEWAY_HOST>?token=<JWT>`. Auto-reconnects after 3 seconds on disconnect.

### Inbound messages handled

| `type` | Store action called |
|---|---|
| `DAILY_MANIFEST_LOADED` | `setDeliveries()` — maps stops to `{ id, lat, lng, time, timeEnd, destination, clientNumber, address, urgency }` |
| `VEHICLE_TELEMETRY` | `updateVehicleTelemetry()` |
| `AI_ROUTE_RECOMMENDATION` | `addRecommendation()` |
| `ROUTE_SYNC_CONFIRMED` | `confirmRecommendationSync()` |
| `DELIVERY_COMPLETED` | `markDeliveryCompleted()` |
| `ACTIVE_ROUTE_UPDATE` | `setActiveRoutes()` |

### Outbound messages sent by components

| `type` | Sender | Payload |
|---|---|---|
| `GET_DAILY_MANIFEST` | `CourierDashboard` on connect | `{}` |
| `APPROVE_ROUTE` | `ActionCard` Approve button | `{ routeId, recommendedStopsOrder }` |
| `REFUSE_ROUTE` | `ActionCard` Refuse button | `{ id }` |
| `SEND_EMAIL` | `ActionCard` Send Email button | `{ id }` |

**Exported:** `{ sendMessage, isConnected }` — `isConnected` drives UI feedback in `CourierDashboard`.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `VITE_API_BASE_URL` | `http://localhost:3000` | Gateway HTTP base URL. WebSocket URL is derived by replacing `http` → `ws`. |

Set in a `.env` file at `frontend/`:
```
VITE_API_BASE_URL=http://localhost:3000
```

---

## Running Locally

```bash
cd frontend
npm install
npm run dev       # Dev server at http://localhost:5173
npm run build     # Production build → dist/
npm run preview   # Serve the production build locally
```

**Login credentials (from database seed):**
- Email: `johndoe@smartlogistics.com`
- Password: `password123`

---

## Docker

The Compose config mounts the `frontend/` directory as a volume so Vite's HMR works inside the container:

```yaml
volumes:
  - ./frontend:/app
  - /app/node_modules
```

Accessible at `http://localhost:8000` when running via `docker compose up`.
