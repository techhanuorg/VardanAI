// Local cache of fetched data
let clinicData = {
  stats: {},
  appointments: [],
  patients: [],
  critical: [],
  chats: []
};

// Charts instances
let trendChart = null;
let shareChart = null;

// Current active tab and filters
let activeTab = 'overview';
let searchQuery = '';
let statusFilter = 'all';
let doctorFilter = 'all';

// DOM Elements
const elements = {
  wsStatus: document.getElementById('ws-status'),
  patientsToday: document.getElementById('stat-patients-today'),
  appointmentsToday: document.getElementById('stat-appointments-today'),
  criticalCases: document.getElementById('stat-critical-cases'),
  activeChats: document.getElementById('stat-active-chats'),
  criticalPulse: document.getElementById('critical-alert-pulse'),
  
  searchInput: document.getElementById('search-input'),
  statusFilterSelect: document.getElementById('status-filter'),
  doctorFilterSelect: document.getElementById('doctor-filter'),
  filterContainer: document.getElementById('filter-container'),
  
  overviewTableBody: document.getElementById('overview-table-body'),
  appointmentsTableBody: document.getElementById('appointments-table-body'),
  patientsTableBody: document.getElementById('patients-table-body'),
  criticalTableBody: document.getElementById('critical-table-body'),
  chatsContainer: document.getElementById('chat-threads-container'),
  
  chatOverlay: document.getElementById('chat-overlay'),
  closeChatBtn: document.getElementById('close-chat-btn'),
  overlayPatientName: document.getElementById('overlay-patient-name'),
  overlayPatientPhone: document.getElementById('overlay-patient-phone'),
  chatStreamBody: document.getElementById('chat-stream-body'),
  
  bookingModal: document.getElementById('booking-modal'),
  openBookingModalBtn: document.getElementById('open-booking-modal-btn'),
  closeBookingModalBtn: document.getElementById('close-booking-modal-btn'),
  cancelBookingBtn: document.getElementById('cancel-booking-btn'),
  manualBookingForm: document.getElementById('manual-booking-form'),
  
  pageTitle: document.getElementById('page-title'),
  refreshCacheBtn: document.getElementById('refresh-cache-btn'),
  currentTimeDisplay: document.getElementById('current-time-display')
};

// Start clock
function updateTime() {
  const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' };
  elements.currentTimeDisplay.textContent = 'Clinic Time: ' + new Date().toLocaleString('en-US', options);
}
setInterval(updateTime, 1000);
updateTime();

// Initialize Dashboard
document.addEventListener('DOMContentLoaded', () => {
  setupTabListeners();
  setupSearchAndFilters();
  setupModalListeners();
  setupSSE();
  reloadData();

  elements.closeChatBtn.addEventListener('click', closeChatLogs);
  elements.chatOverlay.addEventListener('click', (e) => {
    if (e.target === elements.chatOverlay) closeChatLogs();
  });

  elements.refreshCacheBtn.addEventListener('click', () => {
    elements.refreshCacheBtn.disabled = true;
    elements.refreshCacheBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate fa-spin"></i> Syncing...';
    reloadData().finally(() => {
      setTimeout(() => {
        elements.refreshCacheBtn.disabled = false;
        elements.refreshCacheBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> Refresh Cache';
      }, 1000);
    });
  });
});

/**
 * Connects to Server-Sent Events (SSE) for real-time reactivity
 */
function setupSSE() {
  const eventSource = new EventSource('/api/events');

  eventSource.onopen = () => {
    console.log('SSE connection to Express SQLite server opened.');
    setConnectionStatus(true);
  };

  eventSource.onerror = (err) => {
    console.error('SSE connection error:', err);
    setConnectionStatus(false);
  };

  eventSource.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      console.log('Received live SQLite update:', payload);
      
      if (payload.type === 'CONNECTED') return;

      // Real-time flash notification for critical alerts
      if (payload.type === 'CRITICAL_CASE') {
        triggerEmergencyFlash();
      }

      // Reload dashboard states
      reloadData();
    } catch (e) {
      // Ignored non-json messages (keepalive)
    }
  };
}

function setConnectionStatus(isOnline) {
  if (isOnline) {
    elements.wsStatus.className = 'status-indicator-badge online';
    elements.wsStatus.querySelector('.status-text').textContent = 'Live Synced';
  } else {
    elements.wsStatus.className = 'status-indicator-badge offline';
    elements.wsStatus.querySelector('.status-text').textContent = 'Reconnecting...';
  }
}

function triggerEmergencyFlash() {
  const card = document.getElementById('card-critical');
  card.style.animation = 'none';
  setTimeout(() => {
    card.style.animation = 'emergency-flash-animation 1s 3';
  }, 10);
}

/**
 * Tab Navigation Setup
 */
function setupTabListeners() {
  const navItems = document.querySelectorAll('.sidebar-nav .nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      navItems.forEach(btn => btn.classList.remove('active'));
      item.classList.add('active');
      
      activeTab = item.getAttribute('data-tab');
      updateTabVisibility();
    });
  });
}

function updateTabVisibility() {
  // Show / Hide content areas
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.remove('active');
  });
  document.getElementById(`tab-${activeTab}`).classList.add('active');

  const chartsGrid = document.getElementById('overview-charts-grid');
  if (activeTab === 'overview') {
    elements.pageTitle.textContent = 'Clinic Control Center';
    elements.filterContainer.style.display = 'flex';
    elements.statusFilterSelect.style.display = 'inline-block';
    elements.doctorFilterSelect.style.display = 'inline-block';
    chartsGrid.style.display = 'grid';
  } else {
    chartsGrid.style.display = 'none';
    if (activeTab === 'appointments') {
      elements.pageTitle.textContent = 'Appointments Log';
      elements.filterContainer.style.display = 'flex';
      elements.statusFilterSelect.style.display = 'none';
      elements.doctorFilterSelect.style.display = 'inline-block';
    } else if (activeTab === 'patients') {
      elements.pageTitle.textContent = 'Patients Registry';
      elements.filterContainer.style.display = 'none';
    } else if (activeTab === 'critical') {
      elements.pageTitle.textContent = 'Critical Cases';
      elements.filterContainer.style.display = 'none';
    } else if (activeTab === 'chats') {
      elements.pageTitle.textContent = 'WhatsApp Chat Streams';
      elements.filterContainer.style.display = 'none';
    }
  }

  renderData();
}

/**
 * Filter / Search Bindings
 */
function setupSearchAndFilters() {
  elements.searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value.toLowerCase().trim();
    renderData();
  });

  elements.statusFilterSelect.addEventListener('change', (e) => {
    statusFilter = e.target.value;
    renderData();
  });

  elements.doctorFilterSelect.addEventListener('change', (e) => {
    doctorFilter = e.target.value;
    renderData();
  });
}

/**
 * Manual Booking Modal triggers
 */
function setupModalListeners() {
  elements.openBookingModalBtn.addEventListener('click', () => {
    elements.bookingModal.classList.add('open');
    // Set default date as today
    document.getElementById('book-date').value = new Date().toISOString().split('T')[0];
  });

  const closeModal = () => {
    elements.bookingModal.classList.remove('open');
    elements.manualBookingForm.reset();
  };

  elements.closeBookingModalBtn.addEventListener('click', closeModal);
  elements.cancelBookingBtn.addEventListener('click', closeModal);
  
  elements.manualBookingForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const name = document.getElementById('book-name').value.trim();
    const phone = document.getElementById('book-phone').value.trim();
    const age = document.getElementById('book-age').value.trim();
    const gender = document.getElementById('book-gender').value;
    const doctor = document.getElementById('book-doctor').value;
    const date = document.getElementById('book-date').value;
    const time = document.getElementById('book-time').value.trim();
    const problem = document.getElementById('book-problem').value.trim();

    try {
      const res = await fetch('/api/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone, age, gender, doctor, date, time, problem })
      }).then(r => r.json());

      if (res.success) {
        closeModal();
        reloadData();
      } else {
        alert('Booking Error: ' + res.error);
      }
    } catch (err) {
      console.error(err);
      alert('Network error while booking.');
    }
  });
}

/**
 * Data loader: queries SQLite endpoints and saves to local state
 */
async function reloadData() {
  try {
    const [statsRes, apptsRes, patientsRes, critRes, chatsRes] = await Promise.all([
      fetch('/api/stats').then(r => r.json()),
      fetch('/api/appointments').then(r => r.json()),
      fetch('/api/patients').then(r => r.json()),
      fetch('/api/critical').then(r => r.json()),
      fetch('/api/chats').then(r => r.json())
    ]);

    if (statsRes.success) clinicData.stats = statsRes.data;
    if (apptsRes.success) clinicData.appointments = apptsRes.data;
    if (patientsRes.success) clinicData.patients = patientsRes.data;
    if (critRes.success) clinicData.critical = critRes.data;
    if (chatsRes.success) clinicData.chats = chatsRes.data;

    renderData();
    updateCharts();
  } catch (error) {
    console.error('Error reloading dashboard data:', error);
  }
}

/**
 * Renders stats and tables based on active filters and tabs
 */
function renderData() {
  // 1. Render Stats Cards
  elements.patientsToday.textContent = clinicData.stats.patientsToday || 0;
  elements.appointmentsToday.textContent = clinicData.stats.appointmentsToday || 0;
  elements.criticalCases.textContent = clinicData.stats.activeCritical || 0;
  elements.activeChats.textContent = clinicData.stats.uniqueChats || 0;

  if (clinicData.stats.activeCritical > 0) {
    elements.criticalPulse.style.display = 'block';
  } else {
    elements.criticalPulse.style.display = 'none';
  }

  // 2. Render specific tab content
  if (activeTab === 'overview') {
    renderOverviewTable();
  } else if (activeTab === 'appointments') {
    renderAppointmentsTable();
  } else if (activeTab === 'patients') {
    renderPatientsTable();
  } else if (activeTab === 'critical') {
    renderCriticalTable();
  } else if (activeTab === 'chats') {
    renderChatsFeed();
  }
}

/**
 * Render combined list (Overview)
 */
function renderOverviewTable() {
  const combined = [];

  clinicData.appointments.forEach(appt => {
    combined.push({
      type: 'Appointment',
      name: appt.name,
      phone: appt.phone,
      detail: `Consulting: ${appt.doctor}`,
      status: appt.status,
      timestamp: appt.created_at,
      doctor: appt.doctor,
      rawStatus: appt.status
    });
  });

  clinicData.critical.forEach(crit => {
    combined.push({
      type: 'Critical Alert',
      name: crit.phone, // Default to phone if name is unknown
      phone: crit.phone,
      detail: `Symptoms: ${crit.problem}`,
      status: crit.status,
      timestamp: crit.created_at,
      doctor: 'N/A',
      rawStatus: crit.status
    });
  });

  // Sort: Newest entries first
  let filtered = combined.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Apply filters
  if (searchQuery) {
    filtered = filtered.filter(item => 
      item.name.toLowerCase().includes(searchQuery) ||
      item.phone.includes(searchQuery) ||
      item.detail.toLowerCase().includes(searchQuery)
    );
  }

  if (statusFilter !== 'all') {
    filtered = filtered.filter(item => item.rawStatus.toLowerCase() === statusFilter);
  }

  if (doctorFilter !== 'all') {
    filtered = filtered.filter(item => item.doctor === doctorFilter);
  }

  if (filtered.length === 0) {
    elements.overviewTableBody.innerHTML = '<tr class="empty-row"><td colspan="6">No recent events match the filters.</td></tr>';
    return;
  }

  elements.overviewTableBody.innerHTML = filtered.map(item => {
    const isCritical = item.type === 'Critical Alert';
    const typeBadge = isCritical ? 'badge-danger' : 'badge-info';
    const statusBadge = item.rawStatus === 'Active' ? 'badge-danger' : (item.rawStatus === 'Booked' ? 'badge-success' : 'badge-warning');
    const displayTime = formatTimestamp(item.timestamp);

    // Look up patient name in registry for critical alerts if available
    let displayName = item.name;
    if (isCritical) {
      const patient = clinicData.patients.find(p => p.phone === item.phone);
      if (patient) displayName = patient.name;
    }

    return `
      <tr>
        <td>
          <div style="font-weight:600">${escapeHtml(displayName)}</div>
          <div style="font-size:0.75rem;color:var(--text-muted)">${isCritical ? 'Emergency Check' : 'General Appointment'}</div>
        </td>
        <td>${escapeHtml(item.phone)}</td>
        <td>
          <span class="badge ${typeBadge}" style="margin-right:8px">${item.type}</span>
          <span>${escapeHtml(item.detail)}</span>
        </td>
        <td><span class="badge ${statusBadge}">${item.status}</span></td>
        <td>${displayTime}</td>
        <td>
          <button class="btn-sm" onclick="openChatLogs('${item.phone}', '${escapeJs(displayName)}')">
            <i class="fa-solid fa-comments"></i> View Chat
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

/**
 * Render Appointments Tab
 */
function renderAppointmentsTable() {
  let filtered = [...clinicData.appointments].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  // Apply search/doctor filter
  if (searchQuery) {
    filtered = filtered.filter(appt => 
      appt.name.toLowerCase().includes(searchQuery) ||
      appt.phone.includes(searchQuery) ||
      appt.problem.toLowerCase().includes(searchQuery)
    );
  }

  if (doctorFilter !== 'all') {
    filtered = filtered.filter(appt => appt.doctor === doctorFilter);
  }

  if (filtered.length === 0) {
    elements.appointmentsTableBody.innerHTML = '<tr class="empty-row"><td colspan="8">No appointments found.</td></tr>';
    return;
  }

  elements.appointmentsTableBody.innerHTML = filtered.map(appt => {
    return `
      <tr>
        <td style="font-weight:600">${escapeHtml(appt.name)}</td>
        <td>${escapeHtml(appt.phone)}</td>
        <td>${escapeHtml(appt.gender)} (Age: ${escapeHtml(appt.age)})</td>
        <td style="max-width:200px;text-overflow:ellipsis;overflow:hidden;white-space:nowrap">${escapeHtml(appt.problem)}</td>
        <td style="font-weight:500;color:var(--clr-cyan)">${escapeHtml(appt.doctor)}</td>
        <td>
          <div style="font-weight:600">${escapeHtml(appt.date)}</div>
          <div style="font-size:0.75rem;color:var(--text-muted)">Slot: ${escapeHtml(appt.time)}</div>
        </td>
        <td><span class="badge badge-success">${appt.status}</span></td>
        <td>
          <button class="btn-sm" onclick="openChatLogs('${appt.phone}', '${escapeJs(appt.name)}')">
            <i class="fa-solid fa-comments"></i> Logs
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

/**
 * Render Patients Registry Tab
 */
function renderPatientsTable() {
  let filtered = [...clinicData.patients].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  // Apply search
  if (searchQuery) {
    filtered = filtered.filter(p => 
      p.name.toLowerCase().includes(searchQuery) ||
      p.phone.includes(searchQuery) ||
      (p.gender && p.gender.toLowerCase().startsWith(searchQuery))
    );
  }

  if (filtered.length === 0) {
    elements.patientsTableBody.innerHTML = '<tr class="empty-row"><td colspan="7">No patients in registry.</td></tr>';
    return;
  }

  elements.patientsTableBody.innerHTML = filtered.map(p => {
    return `
      <tr>
        <td>#${p.id}</td>
        <td style="font-weight:600">${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.phone)}</td>
        <td>${escapeHtml(p.age || 'N/A')}</td>
        <td><span class="badge badge-info">${escapeHtml(p.gender || 'N/A')}</span></td>
        <td>${formatTimestamp(p.created_at)}</td>
        <td>
          <button class="btn-sm" onclick="openChatLogs('${p.phone}', '${escapeJs(p.name)}')">
            <i class="fa-solid fa-comments"></i> Chat Log
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

/**
 * Render Critical alerts tab
 */
function renderCriticalTable() {
  let filtered = [...clinicData.critical].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  if (searchQuery) {
    filtered = filtered.filter(crit => 
      crit.phone.includes(searchQuery) ||
      crit.problem.toLowerCase().includes(searchQuery)
    );
  }

  if (filtered.length === 0) {
    elements.criticalTableBody.innerHTML = '<tr class="empty-row"><td colspan="6">No critical alerts logged.</td></tr>';
    return;
  }

  elements.criticalTableBody.innerHTML = filtered.map(crit => {
    const badge = crit.status === 'Active' ? 'badge-danger' : 'badge-warning';
    
    // Look up patient name in registry
    const patient = clinicData.patients.find(p => p.phone === crit.phone);
    const displayName = patient?.name || 'Unknown Patient';

    return `
      <tr>
        <td style="font-weight:600">${escapeHtml(displayName)}</td>
        <td>${escapeHtml(crit.phone)}</td>
        <td style="color:var(--clr-rose);font-weight:600">${escapeHtml(crit.problem)}</td>
        <td><span class="badge ${badge}">${crit.status}</span></td>
        <td>${formatTimestamp(crit.created_at)}</td>
        <td>
          <button class="btn-sm" onclick="openChatLogs('${crit.phone}', '${escapeJs(displayName)}')">
            <i class="fa-solid fa-comments"></i> Check Log
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

/**
 * Render Recent Chats list summary
 */
function renderChatsFeed() {
  let filtered = [...clinicData.chats];

  if (searchQuery) {
    filtered = filtered.filter(chat => 
      chat.name.toLowerCase().includes(searchQuery) ||
      chat.phone.includes(searchQuery) ||
      chat.lastMessage.toLowerCase().includes(searchQuery)
    );
  }

  if (filtered.length === 0) {
    elements.chatsContainer.innerHTML = '<p class="empty-text">No active conversation streams found.</p>';
    return;
  }

  elements.chatsContainer.innerHTML = filtered.map(chat => {
    const isBot = chat.lastSender === 'AI';
    const senderTag = isBot ? 'Vardan AI' : 'Patient';
    const tagClass = isBot ? 'badge-info' : 'badge-warning';
    
    return `
      <div class="chat-thread-card" onclick="openChatLogs('${chat.phone}', '${escapeJs(chat.name)}')">
        <div class="thread-main-info">
          <div class="thread-name-row">
            <h4>${escapeHtml(chat.name)}</h4>
            <span>${escapeHtml(chat.phone)}</span>
          </div>
          <div class="thread-snippet">
            <strong style="color:var(--text-muted);font-size:0.8rem">${senderTag}:</strong> ${escapeHtml(chat.lastMessage)}
          </div>
        </div>
        <div class="thread-meta-info">
          <span class="thread-time">${formatTimestamp(chat.timestamp)}</span>
          <span class="badge ${tagClass}" style="font-size:0.65rem">${chat.age} yrs • ${chat.gender}</span>
        </div>
      </div>
    `;
  }).join('');
}

/**
 * Overlay Conversation Stream Renderer
 */
async function openChatLogs(phone, name) {
  try {
    elements.overlayPatientName.textContent = name;
    elements.overlayPatientPhone.textContent = phone;
    elements.chatStreamBody.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding-top:40px;"><i class="fa-solid fa-spinner fa-spin"></i> Fetching records...</p>';
    
    elements.chatOverlay.classList.add('open');

    const res = await fetch(`/api/chats/${phone}`).then(r => r.json());
    if (res.success && res.data.length > 0) {
      elements.chatStreamBody.innerHTML = res.data.map(log => {
        const isBot = log.sender === 'AI';
        const bubbleClass = isBot ? 'receptionist' : 'patient';
        const displayTime = new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        return `
          <div class="chat-bubble ${bubbleClass}">
            <div class="bubble-text">${escapeHtml(log.message)}</div>
            <div class="bubble-timestamp">${displayTime}</div>
          </div>
        `;
      }).join('');
      
      // Auto scroll to latest text
      setTimeout(() => {
        elements.chatStreamBody.scrollTop = elements.chatStreamBody.scrollHeight;
      }, 50);
    } else {
      elements.chatStreamBody.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding-top:40px;">No messages recorded for this phone number.</p>';
    }
  } catch (err) {
    console.error('Error rendering chat history overlay:', err);
    elements.chatStreamBody.innerHTML = '<p style="color:var(--clr-rose);text-align:center;padding-top:40px;">Error loading logs from server.</p>';
  }
}

function closeChatLogs() {
  elements.chatOverlay.classList.remove('open');
}

/**
 * Chart.js Graph Renderers
 */
function updateCharts() {
  const ctxTrend = document.getElementById('appointments-trend-chart');
  const ctxShare = document.getElementById('doctor-share-chart');
  
  if (!ctxTrend || !ctxShare) return;

  // 1. Calculate daily trend counts
  const trendMap = {};
  
  // Initialize last 7 days with zeros
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    trendMap[dateStr] = 0;
  }

  clinicData.appointments.forEach(appt => {
    const dateStr = appt.date;
    if (trendMap[dateStr] !== undefined) {
      trendMap[dateStr]++;
    }
  });

  const dates = Object.keys(trendMap);
  const counts = Object.values(trendMap);

  if (trendChart) trendChart.destroy();
  trendChart = new Chart(ctxTrend.getContext('2d'), {
    type: 'line',
    data: {
      labels: dates.map(d => {
        const parts = d.split('-');
        return `${parts[2]}/${parts[1]}`; // DD/MM format
      }),
      datasets: [{
        label: 'Booked Appointments',
        data: counts,
        borderColor: '#6366f1',
        backgroundColor: 'rgba(99, 102, 241, 0.1)',
        borderWidth: 2,
        fill: true,
        tension: 0.3,
        pointBackgroundColor: '#6366f1'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#94a3b8' } },
        y: { 
          grid: { color: 'rgba(255,255,255,0.03)' }, 
          ticks: { color: '#94a3b8', stepSize: 1 }, 
          beginAtZero: true 
        }
      }
    }
  });

  // 2. Doctor consultation share counts
  const doctorMap = {
    'Dr. Alok Sharma': 0,
    'Dr. Sunita Verma': 0,
    'Dr. Vikas Gupta': 0,
    'Dr. Rajesh Iyer': 0
  };

  clinicData.appointments.forEach(appt => {
    if (doctorMap[appt.doctor] !== undefined) {
      doctorMap[appt.doctor]++;
    }
  });

  const docNames = Object.keys(doctorMap);
  const docCounts = Object.values(doctorMap);
  const colors = ['#06b6d4', '#6366f1', '#f59e0b', '#10b981'];

  if (shareChart) shareChart.destroy();
  shareChart = new Chart(ctxShare.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: ['Physician', 'Pediatrician', 'Cardiologist', 'Orthopedic'],
      datasets: [{
        data: docCounts,
        backgroundColor: colors,
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: { color: '#94a3b8', font: { family: 'Plus Jakarta Sans', size: 10 } }
        }
      }
    }
  });
}

/**
 * Utilities
 */
function formatTimestamp(isoStr) {
  if (!isoStr) return '';
  const date = new Date(isoStr);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${day}, ${time}`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeJs(str) {
  if (!str) return '';
  return str.toString().replace(/'/g, "\\'");
}
