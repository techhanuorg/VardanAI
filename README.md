# WhatsApp AI Clinic Receptionist (Vardan Hospital)

A production-ready, modular WhatsApp AI Receptionist built with Node.js to manage booking, patient registry, and real-time emergency screening for a doctor's clinic.

This project is completely local and runs on **SQLite** (via built-in `node:sqlite`), meaning there are **no Google Cloud or Google Sheets API dependencies**.

## Features

1. **WhatsApp QR Login**: Scans and saves persistent authentication keys in the `auth/` directory. Automatically reconnects when disconnected.
2. **AI Receptionist (Gemini 2.5 Flash)**: Chatbot powered by `@google/genai` that behaves like a human hospital receptionist, speaks polite Hinglish, and collects patient details.
3. **SQLite Database**: Local SQLite file (`data/hospital.db`) created automatically on first boot.
4. **Structured Context Memory**: Maintains conversation threads and patient profile metadata. Persists across restarts by loading recent chats and registry profiles from SQLite.
5. **Real-time Emergency Screening**: Intercepts symptoms like chest pain, heavy bleeding, or breathing issues. Immediately routes emergency instructions to the patient, registers the case under `Critical Cases`, and flashes the admin dashboard.
6. **Reactive Clinic Dashboard**: Modern dark theme grid showing clinic statistics, appointments table, critical alerts, and recent WhatsApp chat history using **Server-Sent Events (SSE)** for real-time updates.
7. **Charts & Analytics**: Integrates **Chart.js** on the frontend to visualize appointment trends over the last 7 days and doctor consultation shares.
8. **Manual Appointment Booking**: Includes a web form modal on the dashboard to manually book appointments directly into SQLite.

---

## Tech Stack

- **Backend**: Express.js (Node.js)
- **WhatsApp Web API**: `@whiskeysockets/baileys`
- **AI Model**: Google Gemini 2.5 Flash via `@google/genai`
- **Database**: SQLite via native `node:sqlite` (zero external dependencies)
- **Logging**: `pino`
- **QR Code Output**: `qrcode-terminal`

---

## Database Tables

### 1. `patients`
Tracks registered patients.
- `id` (INTEGER PRIMARY KEY AUTOINCREMENT)
- `phone` (TEXT UNIQUE)
- `name` (TEXT)
- `age` (TEXT)
- `gender` (TEXT)
- `created_at` (DATETIME DEFAULT CURRENT_TIMESTAMP)

### 2. `appointments`
Tracks booked clinic consultations.
- `id` (INTEGER PRIMARY KEY AUTOINCREMENT)
- `patient_id` (INTEGER, FOREIGN KEY REFERENCES patients(id))
- `doctor` (TEXT)
- `date` (TEXT)
- `time` (TEXT)
- `problem` (TEXT)
- `status` (TEXT DEFAULT 'Booked')
- `created_at` (DATETIME DEFAULT CURRENT_TIMESTAMP)

### 3. `messages`
Tracks chronological user texts and corresponding bot replies.
- `id` (INTEGER PRIMARY KEY AUTOINCREMENT)
- `phone` (TEXT)
- `message` (TEXT)
- `reply` (TEXT)
- `created_at` (DATETIME DEFAULT CURRENT_TIMESTAMP)

### 4. `critical_cases`
Tracks flagged medical emergencies.
- `id` (INTEGER PRIMARY KEY AUTOINCREMENT)
- `phone` (TEXT)
- `problem` (TEXT)
- `status` (TEXT DEFAULT 'Active')
- `created_at` (DATETIME DEFAULT CURRENT_TIMESTAMP)

---

## Dashboard Express API

- **`GET /api/stats`**: Aggregated statistics for cards.
- **`GET /api/patients`**: Retrieve list of registered patients.
- **`GET /api/appointments`**: Retrieve list of booked appointments with patient details.
- **`GET /api/messages`**: Retrieve list of all logged WhatsApp conversation rows.
- **`GET /api/critical`**: Retrieve list of critical cases.
- **`POST /api/book`**: Book an appointment manually.
  - Required JSON body: `{ name, phone, age, gender, doctor, date, time, problem }`

---

## Installation & Setup

1. Navigate to the project directory:
   ```bash
   cd whatsapp-ai
   ```

2. Install all dependencies:
   ```bash
   npm install
   ```

3. Create your `.env` configuration file:
   ```env
   PORT=3000
   GEMINI_API_KEY=your_gemini_api_key_here
   ```

---

## Running the Application

Start the clinic server (which launches the web dashboard and the WhatsApp client):
```bash
npm start
```

### Scanning the QR Code
On startup, a QR code will print in your terminal:
1. Open WhatsApp on your phone.
2. Go to **Linked Devices > Link a Device**.
3. Scan the QR code displayed in the terminal.
4. Once scanned, the terminal will log: `WhatsApp AI Receptionist successfully connected and active!`.

---

## Accessing the Dashboard

Open your browser and navigate to:
```
http://localhost:3000
```
The dashboard will show live statistics, active charts, critical emergency alerts, appointment tables, and allow you to view historical conversation logs in a chat mock panel.
