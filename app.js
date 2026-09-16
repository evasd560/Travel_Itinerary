/* ==========================================
   Detour Travel Itinerary Application Logic
   ========================================== */

document.addEventListener("DOMContentLoaded", () => {
  /* The app was called Vagabond before it was Detour. Carry any saved keys over
     once so the rename doesn't wipe existing bookmarks, notes and itineraries. */
  (function migrateLegacyStorage() {
    try {
      Object.keys(localStorage)
        .filter(key => key.startsWith("vagabond_"))
        .forEach(key => {
          const renamed = key.replace(/^vagabond_/, "detour_");
          if (localStorage.getItem(renamed) === null) {
            localStorage.setItem(renamed, localStorage.getItem(key));
          }
          localStorage.removeItem(key);
        });
    } catch (e) {
      // Private-mode or quota errors just mean starting fresh, which is fine
    }
  })();

  // 1. Application State
  const state = {
    apiKey: localStorage.getItem("detour_gemini_key") || "",
    currentCity: null, // Holds currently loaded city object
    currentCategory: "all",
    // Secondary filters
    filterZone: "all",
    filterLocation: "all",
    filterSocials: false,
    filterBookmarked: false,
    activeDay: 1,
    activeWeek: 1,
    // Which of the two full-width views is showing: browse cards or the planner
    viewMode: localStorage.getItem("detour_view_mode") === "plan" ? "plan" : "explore",
    planMode: "day", // "day" | "week"
    // The open day in the day-wise accordion can be collapsed without losing
    // which day new items get added to
    dayCollapsed: false,
    // Days whose pins are hidden from the map (empty = show everything)
    hiddenMapDays: [],
    // The last length you chose sticks across reloads rather than snapping back to 3
    tripDuration: parseInt(localStorage.getItem("detour_trip_duration"), 10) || 3,
    itinerary: {},
    // Plans you've built at other trip lengths, keyed "<city>|<days>", so going
    // 21 → 7 → 21 gives you your 21-day plan back instead of a fresh rebuild.
    durationCache: JSON.parse(localStorage.getItem("detour_duration_cache")) || {},
    // Named dividers inside a week: { [weekNumber]: [{ id, name }] }
    weekSections: {},
    // Per-city itinerary storage, keyed by city name (lowercase), so switching
    // destinations doesn't lose the itinerary built for a previously viewed city.
    itineraryByCity: {},
    plannerWidth: parseInt(localStorage.getItem("detour_planner_width"), 10) || 340,
    // Width of the map column in the Plan view's desktop split
    mapWidth: parseInt(localStorage.getItem("detour_map_width"), 10) || 420,
    pendingDuration: null,
    bookmarks: JSON.parse(localStorage.getItem("detour_bookmarks")) || [],
    notes: JSON.parse(localStorage.getItem("detour_notes")) || {},
    cardEdits: JSON.parse(localStorage.getItem("detour_card_edits")) || {},
    cityCovers: JSON.parse(localStorage.getItem("detour_city_covers")) || {},
    tripStartDate: localStorage.getItem("detour_trip_start") || "",
    // Hours are opt-in per day: { [day]: { start, end } }
    dayHours: JSON.parse(localStorage.getItem("detour_day_hours")) || {},
    dayStartTime: "09:00",
    dayEndTime: "21:00",
    weather: null,
    plannerCollapsed: false,
    editingItemId: null,
    editingCover: false
  };

  const PINNED_CITY_KEY = "vietnam";
  const GEMINI_MODEL = "gemini-3.8-flash";
  const TRANSIT_BUFFER_MIN = 20; // Buffer added between scheduled items for travel time
  const MAX_TRIP_DAYS = 31; // Up to ~1 month
  const DAYS_PER_WEEK = 7;
  const CATEGORY_EMOJI = { visit: "🏛️", dish: "🍜", eat: "🍽️", activity: "🏄", shopping: "🛍️", happening: "🌸", custom: "📍" };
  const CATEGORY_LABEL = {
    visit: "Landmark",
    dish: "Dish to Try",
    eat: "Place to Eat",
    activity: "Activity",
    shopping: "Shopping",
    happening: "While You're There",
    custom: "Custom"
  };

  // 2. DOM Elements Cache
  const els = {
    tripTabs: document.getElementById("trip-tabs"),
    apiStatusBadge: document.getElementById("api-status-badge"),
    settingsModal: document.getElementById("settings-modal"),
    closeSettingsBtn: document.getElementById("close-settings-btn"),
    saveKeyBtn: document.getElementById("save-key-btn"),
    clearKeyBtn: document.getElementById("clear-key-btn"),
    geminiApiKeyInput: document.getElementById("gemini-api-key"),
    searchInput: document.getElementById("search-input"),
    searchSuggestions: document.getElementById("search-suggestions"),
    searchBtn: document.getElementById("search-button"),
    // Hero
    cityHeroMedia: document.getElementById("city-hero-media"),
    coverEditBtn: document.getElementById("cover-edit-btn"),
    heroTitle: document.getElementById("hero-title"),
    heroDesc: document.getElementById("hero-desc"),
    // Filters
    categoryFilterBar: document.getElementById("category-filter-bar"),
    zoneFilterBar: document.getElementById("zone-filter-bar"),
    locationFilterBar: document.getElementById("location-filter-bar"),
    filterSocialsBtn: document.getElementById("filter-socials-btn"),
    filterBookmarksBtn: document.getElementById("filter-bookmarks-btn"),
    recommendationsGrid: document.getElementById("recommendations-grid"),
    // Planner
    plannerSidebar: document.getElementById("planner-sidebar"),
    plannerBody: document.getElementById("planner-body"),
    plannerCollapseBtn: document.getElementById("planner-collapse-btn"),
    plannerResizeHandle: document.getElementById("planner-resize-handle"),
    plannerRail: document.getElementById("planner-rail"),
    plannerRailCount: document.getElementById("planner-rail-count"),
    appContainer: document.querySelector(".app-container"),
    viewSwitch: document.getElementById("view-switch"),
    planSplit: document.getElementById("plan-split"),
    planSplitHandle: document.getElementById("plan-split-handle"),
    viewSwitchCount: document.getElementById("view-switch-count"),
    weekSectionRow: document.getElementById("week-section-row"),
    addSectionBtn: document.getElementById("add-section-btn"),
    durationConfirmModal: document.getElementById("duration-confirm-modal"),
    durationConfirmTitle: document.getElementById("duration-confirm-title"),
    durationConfirmText: document.getElementById("duration-confirm-text"),
    durationConfirmDetail: document.getElementById("duration-confirm-detail"),
    closeDurationConfirmBtn: document.getElementById("close-duration-confirm-btn"),
    durationRebuildBtn: document.getElementById("duration-rebuild-btn"),
    durationKeepBtn: document.getElementById("duration-keep-btn"),
    tripDurationSelect: document.getElementById("trip-duration-select"),
    durationMinus: document.getElementById("duration-minus"),
    durationPlus: document.getElementById("duration-plus"),
    planModeToggle: document.getElementById("plan-mode-toggle"),
    plannerActionsRow: document.getElementById("planner-actions-row"),
    weatherChipRow: document.getElementById("weather-chip-row"),
    weatherChip: document.getElementById("weather-chip"),
    weatherChipIcon: document.getElementById("weather-chip-icon"),
    weatherChipDot: document.getElementById("weather-chip-dot"),
    weatherModal: document.getElementById("weather-modal"),
    weatherModalBody: document.getElementById("weather-modal-body"),
    closeWeatherModalBtn: document.getElementById("close-weather-modal-btn"),
    weatherNudgeModal: document.getElementById("weather-nudge-modal"),
    weatherNudgeTitle: document.getElementById("weather-nudge-title"),
    weatherNudgeBody: document.getElementById("weather-nudge-body"),
    closeWeatherNudgeBtn: document.getElementById("close-weather-nudge-btn"),
    mapAddPinBtn: document.getElementById("map-addpin-btn"),
    itemDetailModal: document.getElementById("item-detail-modal"),
    detailPhoto: document.getElementById("detail-photo"),
    detailBody: document.getElementById("detail-body"),
    closeDetailBtn: document.getElementById("close-detail-btn"),
    clearItineraryBtn: document.getElementById("clear-itinerary-btn"),
    dayNavigator: document.getElementById("day-navigator"),
    itineraryList: document.getElementById("itinerary-list"),
    itineraryMap: document.getElementById("itinerary-map"),
    mapAddLocation: document.getElementById("map-add-location"),
    mapExpandBtn: document.getElementById("map-expand-btn"),
    mapExpandModal: document.getElementById("map-expand-modal"),
    mapModalBody: document.getElementById("map-modal-body"),
    mapModalTitle: document.getElementById("map-modal-title"),
    closeMapModalBtn: document.getElementById("close-map-modal-btn"),
    plannerMapSection: document.querySelector(".planner-map-section"),
    tripStartDate: document.getElementById("trip-start-date"),
    tripEndDate: document.getElementById("trip-end-date"),
    happeningsRow: document.getElementById("happenings-row"),
    findHappeningsBtn: document.getElementById("find-happenings-btn"),
    findHappeningsLabel: document.getElementById("find-happenings-label"),
    customLocationInput: document.getElementById("custom-location-input"),
    customLocationAddBtn: document.getElementById("custom-location-add-btn"),
    exportItineraryBtn: document.getElementById("export-itinerary-btn"),
    // Edit-card modal (also used for the city cover photo)
    editCardModal: document.getElementById("edit-card-modal"),
    editModalTitle: document.getElementById("edit-modal-title"),
    closeEditModalBtn: document.getElementById("close-edit-modal-btn"),
    editImageUrlInput: document.getElementById("edit-image-url"),
    editPasteZone: document.getElementById("edit-paste-zone"),
    editImagePreview: document.getElementById("edit-image-preview"),
    editPasteHint: document.getElementById("edit-paste-hint"),
    editDescriptionGroup: document.getElementById("edit-description-group"),
    editDescriptionInput: document.getElementById("edit-description"),
    resetEditBtn: document.getElementById("reset-edit-btn"),
    saveEditBtn: document.getElementById("save-edit-btn"),
    // Add New modal
    addNewBtn: document.getElementById("add-new-btn"),
    addNewModal: document.getElementById("add-new-modal"),
    closeAddNewBtn: document.getElementById("close-add-new-btn"),
    addNewModeToggle: document.getElementById("add-new-mode-toggle"),
    addManualPane: document.getElementById("add-manual-pane"),
    addLinkPane: document.getElementById("add-link-pane"),
    manualName: document.getElementById("manual-name"),
    manualCategory: document.getElementById("manual-category"),
    manualDuration: document.getElementById("manual-duration"),
    manualLocation: document.getElementById("manual-location"),
    manualCost: document.getElementById("manual-cost"),
    manualImage: document.getElementById("manual-image"),
    manualDescription: document.getElementById("manual-description"),
    manualErrorBox: document.getElementById("manual-error-box"),
    manualSaveBtn: document.getElementById("manual-save-btn"),
    importUrlInput: document.getElementById("import-url-input"),
    importAnalyzeBtn: document.getElementById("import-analyze-btn"),
    importErrorBox: document.getElementById("import-error-box"),
    importResultsList: document.getElementById("import-results-list"),
    importAddSelectedBtn: document.getElementById("import-add-selected-btn")
  };

  // Leaflet map instance + marker layer, created lazily on first use
  let mapInstance = null;
  let mapMarkersLayer = null;
  // Holds the in-progress image value (URL or pasted data URL) while the edit modal is open
  let pendingEditImage = "";
  let importCandidates = [];
  // The link those candidates were pulled from, saved onto each imported item
  let importSourceUrl = "";
  let draggedWeekEntry = null;

  // 2b. Time & Duration Helpers
  function parseDurationToMinutes(item) {
    if (typeof item.durationMinutes === "number") return item.durationMinutes;
    const text = (item.duration || "").toLowerCase();
    if (!text) return 60;
    if (text.includes("full day")) return 480;
    if (text.includes("half day")) return 240;
    const dayMatch = text.match(/(\d+(\.\d+)?)\s*day/);
    if (dayMatch) return Math.round(parseFloat(dayMatch[1]) * 1440);
    const hourMatch = text.match(/(\d+(\.\d+)?)\s*h/);
    if (hourMatch) return Math.round(parseFloat(hourMatch[1]) * 60);
    const minMatch = text.match(/(\d+)\s*m/);
    if (minMatch) return parseInt(minMatch[1], 10);
    return 60;
  }

  function isMultiDay(item) {
    if (typeof item.multiDay === "boolean") return item.multiDay;
    return parseDurationToMinutes(item) >= 720;
  }

  function formatMinutes(mins) {
    if (mins >= 1440) {
      const days = Math.round((mins / 1440) * 10) / 10;
      return `${days}d`;
    }
    if (mins >= 60) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    return `${mins}m`;
  }

  function parseTimeToMinutes(hhmm) {
    const [h, m] = (hhmm || "09:00").split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  function formatClock(totalMinutes) {
    const normalized = ((totalMinutes % 1440) + 1440) % 1440;
    const h = Math.floor(normalized / 60);
    const m = normalized % 60;
    const period = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, "0")} ${period}`;
  }

  // Builds a standardized itinerary entry, carrying scheduling + map data along with it
  function buildItineraryEntry(item) {
    return {
      id: item.id,
      name: item.name,
      category: item.category,
      zone: item.zone || "",
      duration: item.duration || "N/A",
      durationMinutes: parseDurationToMinutes(item),
      multiDay: isMultiDay(item),
      lat: typeof item.lat === "number" ? item.lat : null,
      lng: typeof item.lng === "number" ? item.lng : null
    };
  }

  // 2b-ii. Day / Week scope helpers — week view is an aggregation of that week's days,
  // so anything added in either view shows up in the other.
  function totalWeeks() {
    return Math.max(1, Math.ceil(state.tripDuration / DAYS_PER_WEEK));
  }

  function daysInWeek(week) {
    const start = (week - 1) * DAYS_PER_WEEK + 1;
    const end = Math.min(week * DAYS_PER_WEEK, state.tripDuration);
    const days = [];
    for (let d = start; d <= end; d++) days.push(d);
    return days;
  }

  function weekOfDay(day) {
    return Math.floor((day - 1) / DAYS_PER_WEEK) + 1;
  }

  // Days currently in view: one day, or every day of the active week
  function scopeDays() {
    return state.planMode === "week" ? daysInWeek(state.activeWeek) : [state.activeDay];
  }

  // All entries in the current scope, tagged with the day they sit on
  function scopeEntries() {
    const entries = [];
    scopeDays().forEach(day => {
      (state.itinerary[day] || []).forEach((entry, index) => {
        entries.push({ entry, day, index });
      });
    });
    return entries;
  }

  // Where a newly added item should land. In week mode we spread across the week's
  // least-loaded day so the day-wise view stays sane when you zoom back in.
  function targetDayForAdd() {
    if (state.planMode !== "week") return state.activeDay;
    const days = daysInWeek(state.activeWeek);
    let best = days[0];
    days.forEach(d => {
      if ((state.itinerary[d] || []).length < (state.itinerary[best] || []).length) best = d;
    });
    return best;
  }

  function findScheduledEntry(itemId) {
    for (const day of scopeDays()) {
      const index = (state.itinerary[day] || []).findIndex(e => e.id === itemId);
      if (index > -1) return { day, index };
    }
    return null;
  }

  // 2c. Notes Helpers
  function getNote(itemId) {
    return state.notes[itemId] || "";
  }

  function saveNote(itemId, text) {
    if (text && text.trim()) {
      state.notes[itemId] = text;
    } else {
      delete state.notes[itemId];
    }
    localStorage.setItem("detour_notes", JSON.stringify(state.notes));
  }

  function buildNotesMarkup(itemId) {
    const note = getNote(itemId);
    const hasNote = !!note;
    return `
      <button class="notes-toggle ${hasNote ? "has-note" : ""}" data-note-toggle="${itemId}">
        <span class="material-icons">${hasNote ? "sticky_note_2" : "note_add"}</span>
        <span>${hasNote ? "Note" : "Add note"}</span>
      </button>
      <div class="notes-box" data-note-box="${itemId}">
        <textarea placeholder="Jot a note for this…" data-note-input="${itemId}">${note}</textarea>
      </div>
    `;
  }

  function wireNotesInteractions(container, itemId) {
    const toggleBtn = container.querySelector(`[data-note-toggle="${itemId}"]`);
    const box = container.querySelector(`[data-note-box="${itemId}"]`);
    const textarea = container.querySelector(`[data-note-input="${itemId}"]`);
    if (!toggleBtn || !box || !textarea) return;

    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      box.classList.toggle("open");
      if (box.classList.contains("open")) textarea.focus();
    });

    textarea.addEventListener("click", (e) => e.stopPropagation());
    textarea.addEventListener("input", () => {
      saveNote(itemId, textarea.value);
      const hasNote = !!textarea.value.trim();
      toggleBtn.classList.toggle("has-note", hasNote);
      toggleBtn.innerHTML = `
        <span class="material-icons">${hasNote ? "sticky_note_2" : "note_add"}</span>
        <span>${hasNote ? "Note" : "Add note"}</span>
      `;
    });
  }

  // 2d. Card Edit Helpers (override a card's image / description locally)
  function getCardEdit(itemId) {
    return state.cardEdits[itemId] || {};
  }

  function updateEditPreview(src) {
    if (src) {
      els.editImagePreview.src = src;
      els.editImagePreview.style.display = "block";
      els.editPasteHint.style.display = "none";
    } else {
      els.editImagePreview.style.display = "none";
      els.editPasteHint.style.display = "flex";
    }
  }

  function openEditModal(item) {
    state.editingItemId = item.id;
    state.editingCover = false;
    const edit = getCardEdit(item.id);
    const effectiveImage = edit.image || item.image || "";
    const effectiveDescription = edit.description || item.description || "";

    els.editModalTitle.textContent = "Edit Card";
    els.editDescriptionGroup.style.display = "flex";
    pendingEditImage = effectiveImage;
    els.editImageUrlInput.value = effectiveImage;
    els.editDescriptionInput.value = effectiveDescription;
    updateEditPreview(effectiveImage || null);
    els.editCardModal.showModal();
  }

  function openCoverModal() {
    if (!state.currentCity) return;
    state.editingItemId = null;
    state.editingCover = true;

    const current = getCoverImage();
    els.editModalTitle.textContent = `Cover photo — ${state.currentCity.name}`;
    els.editDescriptionGroup.style.display = "none";
    pendingEditImage = current || "";
    els.editImageUrlInput.value = current || "";
    updateEditPreview(current || null);
    els.editCardModal.showModal();
  }

  // 2e. Custom Location Helpers (paste a Google Maps link or place name to pin it)
  function extractLatLngFromText(text) {
    let m = text.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/); // full Google Maps URL: .../@lat,lng,zoom
    if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

    m = text.match(/[?&](?:q|ll|query)=(-?\d+\.\d+),(-?\d+\.\d+)/); // ?q=lat,lng / ?ll=lat,lng
    if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

    m = text.trim().match(/^(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/); // bare "lat, lng"
    if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };

    return null;
  }

  function extractPlaceNameFromGoogleUrl(text) {
    const m = text.match(/\/place\/([^/@]+)/);
    return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : null;
  }

  async function geocodeQuery(query) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Geocoding request failed.");
    const results = await res.json();
    if (!results.length) throw new Error(`Couldn't find a location for "${query}". Try a more specific name or paste a full Google Maps link.`);
    return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
  }

  async function handleAddCustomLocation(rawText) {
    const text = rawText.trim();
    if (!text) return;

    const isUrl = /^https?:\/\//i.test(text);
    let coords = extractLatLngFromText(text);
    let name = isUrl ? extractPlaceNameFromGoogleUrl(text) : text;

    if (!coords) {
      const query = isUrl ? (extractPlaceNameFromGoogleUrl(text) || text) : text;
      coords = await geocodeQuery(query);
    }
    if (!name) name = "Custom location";

    const entry = {
      id: `custom-${Date.now()}`,
      name,
      category: "custom",
      zone: "",
      duration: "1h",
      durationMinutes: 60,
      multiDay: false,
      lat: coords.lat,
      lng: coords.lng,
      link: isUrl ? text : null
    };

    const day = targetDayForAdd();
    if (!state.itinerary[day]) state.itinerary[day] = [];
    state.itinerary[day].push(entry);
    renderItinerary();
  }

  // 3. Initialize App
  // Show the wordmark image if it loads; otherwise the type fallback stays put
  /* ---------- Map key ---------- */

  function initMapLegend() {
    const btn = document.getElementById("map-legend-btn");
    const panel = document.getElementById("map-legend");
    const list = document.getElementById("map-legend-list");
    if (!btn || !panel || !list) return;

    list.innerHTML = MAP_LEGEND.map(({ key, label }) => `
      <li>
        <span class="legend-glyph">${MAP_PIN_EMOJI[key]}</span>
        <span class="legend-label">${label}</span>
      </li>
    `).join("");

    const setOpen = (open) => {
      panel.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
      btn.classList.toggle("active", open);
    };

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setOpen(panel.hidden);
    });

    // Click anywhere else, or press Escape, to put the key away
    document.addEventListener("click", (e) => {
      if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) setOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !panel.hidden) setOpen(false);
    });
  }

  function initBrandLogo() {
    const img = document.getElementById("brand-logo-img");
    const text = document.getElementById("brand-logo-text");
    if (!img || !text) return;

    const useImage = () => {
      img.hidden = false;
      text.hidden = true;
    };

    if (img.complete) {
      if (img.naturalWidth > 0) useImage();
      return;
    }
    img.addEventListener("load", useImage);
  }

  /* ---------- Explore / Plan modes ---------- */

  function applyViewMode() {
    els.appContainer.dataset.view = state.viewMode;

    els.viewSwitch.querySelectorAll(".view-switch-btn").forEach(btn => {
      const on = btn.dataset.view === state.viewMode;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", String(on));
    });

    // The planner is display:none in Explore, so Leaflet needs to re-measure
    // once it becomes visible again — and again after the CSS width settles.
    if (state.viewMode === "plan") {
      requestAnimationFrame(() => {
        invalidateMapSize();
        updateItineraryColumns();
      });
      setTimeout(invalidateMapSize, 260);
    }
  }

  function setViewMode(mode) {
    if (state.viewMode === mode) return;
    state.viewMode = mode;
    localStorage.setItem("detour_view_mode", mode);
    applyViewMode();
  }

  function updateViewSwitchCount() {
    const total = Object.values(state.itinerary).reduce((sum, day) => sum + day.length, 0);
    els.viewSwitchCount.textContent = String(total);
    els.viewSwitchCount.dataset.empty = String(total === 0);
  }

  els.viewSwitch.addEventListener("click", (e) => {
    const btn = e.target.closest(".view-switch-btn");
    if (btn) setViewMode(btn.dataset.view);
  });

  function init() {
    initBrandLogo();
    initMapLegend();
    applyViewMode();
    updateApiBadge();
    els.plannerSidebar.style.flexBasis = `${state.plannerWidth}px`;
    els.appContainer.style.setProperty("--plan-map-width", `${state.mapWidth}px`);
    els.tripDurationSelect.value = String(state.tripDuration);
    renderTripDates();

    // Reorder within a day (day-wise list view only)
    els.itineraryList.addEventListener("dragover", (e) => {
      if (state.planMode !== "day") return;
      e.preventDefault();
      const draggingItem = els.itineraryList.querySelector(".dragging");
      if (!draggingItem) return;
      const siblings = [...els.itineraryList.querySelectorAll(".itinerary-todo-row:not(.dragging)")];

      const nextSibling = siblings.find(sibling => {
        const box = sibling.getBoundingClientRect();
        const offset = e.clientY - box.top - box.height / 2;
        return offset < 0;
      });

      els.itineraryList.insertBefore(draggingItem, nextSibling);
    });

    // Load default landing city
    loadCity("vietnam");
  }

  // Adjusts state.itinerary keys according to state.tripDuration
  function adjustItineraryDays() {
    const newItinerary = {};
    for (let d = 1; d <= state.tripDuration; d++) {
      newItinerary[d] = state.itinerary[d] || [];
    }
    state.itinerary = newItinerary;

    if (state.activeDay > state.tripDuration) state.activeDay = 1;
    if (state.activeWeek > totalWeeks()) state.activeWeek = 1;

    rebuildPlannerTabs();
    renderItinerary();
  }

  // Changing trip length is destructive, so ask first and let the user choose how to apply it
  function requestTripDuration(days) {
    let value = parseInt(days, 10);
    if (!Number.isFinite(value) || value < 1) value = 1;
    if (value > MAX_TRIP_DAYS) value = MAX_TRIP_DAYS;

    if (value === state.tripDuration) {
      els.tripDurationSelect.value = state.tripDuration;
      return;
    }

    // Nothing to lose yet — just apply it
    if (!itineraryHasItems(state.itinerary)) {
      applyTripDuration(value, true);
      return;
    }

    state.pendingDuration = value;
    const growing = value > state.tripDuration;
    const plan = previewPlan(value);

    els.durationConfirmTitle.textContent = growing ? "Extend your trip?" : "Shorten your trip?";
    els.durationConfirmText.innerHTML = `Change <strong>${state.currentCity ? state.currentCity.name : "this trip"}</strong> from <strong>${state.tripDuration} days</strong> to <strong>${value} days</strong>?`;
    els.durationConfirmDetail.innerHTML = `
      <strong>Rebuilding</strong> re-routes the whole trip geographically and pulls in more to do:<br>
      ${plan}
      <br><br>Your notes and bookmarks are kept either way.
    `;
    els.durationConfirmModal.showModal();
  }

  // A short human summary of how the rebuilt trip would be laid out
  function previewPlan(days) {
    const blocks = planZoneBlocks(days);
    if (!blocks.length) return `${days} days of your plan.`;
    return blocks
      .map(b => `· <strong>${b.zone}</strong> — ${b.days} day${b.days > 1 ? "s" : ""}`)
      .join("<br>");
  }

  /* ---------- Plans remembered per trip length ---------- */

  function durationCacheKey(days) {
    const city = state.currentCity ? cityKeyFor(state.currentCity) : "none";
    return `${city}|${days}`;
  }

  function persistDurationCache() {
    try {
      localStorage.setItem("detour_duration_cache", JSON.stringify(state.durationCache));
    } catch (e) {
      // Quota is the only realistic failure here, and a lost cache is recoverable
    }
  }

  // Snapshot whatever is planned right now against the length it was built for
  function snapshotDuration(days) {
    if (!state.currentCity) return;
    if (!itineraryHasItems(state.itinerary)) return;
    state.durationCache[durationCacheKey(days)] = {
      itinerary: JSON.parse(JSON.stringify(state.itinerary)),
      weekSections: JSON.parse(JSON.stringify(state.weekSections || {}))
    };
    persistDurationCache();
  }

  function restoreDuration(days) {
    const saved = state.durationCache[durationCacheKey(days)];
    if (!saved) return false;
    state.itinerary = JSON.parse(JSON.stringify(saved.itinerary));
    state.weekSections = JSON.parse(JSON.stringify(saved.weekSections || {}));
    return true;
  }

  // Shrinking without a saved plan for the new length: keep the must-visits and
  // the highest-priority items that still fit, rather than dumping the overflow
  // onto the last day.
  function condenseItinerary(days) {
    const all = [];
    Object.keys(state.itinerary)
      .map(Number)
      .sort((a, b) => a - b)
      .forEach(d => (state.itinerary[d] || []).forEach(entry => all.push(entry)));

    const ranked = all
      .map((entry, i) => ({ entry, i, rank: priorityRank(sourceItemFor(entry)) }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i);

    const next = {};
    for (let d = 1; d <= days; d++) next[d] = [];

    let day = 1;
    let used = 0;
    ranked.forEach(({ entry }) => {
      if (day > days) return; // Anything past the new length is dropped
      const mins = parseDurationToMinutes(entry) + TRANSIT_BUFFER_MIN;
      const budget = dailyBudgetMinutes(day);
      if (used > 0 && used + mins > budget) {
        day++;
        used = 0;
      }
      if (day > days) return;
      next[day].push(entry);
      used += mins;
    });

    // Put each day back into geographic order so the route still makes sense
    Object.keys(next).forEach(d => {
      next[d] = orderDayGeographically(next[d]);
    });

    state.itinerary = next;
    Object.keys(state.weekSections).forEach(week => {
      if (parseInt(week, 10) > Math.ceil(days / DAYS_PER_WEEK)) delete state.weekSections[week];
    });
  }

  // Nearest-neighbour ordering within a single day
  function orderDayGeographically(entries) {
    if (entries.length < 3) return entries;
    const remaining = entries.slice();
    const ordered = [remaining.shift()];
    while (remaining.length) {
      const last = sourceItemFor(ordered[ordered.length - 1]);
      let best = 0;
      let bestDist = Infinity;
      remaining.forEach((candidate, i) => {
        const d = distanceBetween(last, sourceItemFor(candidate));
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      });
      ordered.push(remaining.splice(best, 1)[0]);
    }
    return ordered;
  }

  function applyTripDuration(days, rebuild) {
    const previous = state.tripDuration;

    // Remember the plan at the length it was built for before changing anything
    if (days !== previous) snapshotDuration(previous);

    state.tripDuration = days;
    els.tripDurationSelect.value = days;
    localStorage.setItem("detour_trip_duration", String(days));

    if (rebuild) {
      state.weekSections = {};
      state.activeDay = 1;
      state.activeWeek = 1;
      generateIdealItinerary();
      snapshotDuration(days);
      renderTripDates();
      return;
    }

    // Keeping your items: prefer the plan you already built at this length
    if (restoreDuration(days)) {
      state.activeDay = 1;
      state.activeWeek = 1;
      adjustItineraryDays();
      renderTripDates();
      renderRecommendations();
      return;
    }

    if (days < previous) condenseItinerary(days);

    adjustItineraryDays();
    snapshotDuration(days);
    renderTripDates();
    renderRecommendations();
  }

  /* ---------- Route planning ----------
     Zones are visited in geographic order (north → south by average latitude) and each
     gets a contiguous block of days sized by how much there is to do there. That way a
     21-day trip becomes "a week in the north, a week in the centre, a week in the south"
     rather than the same three zones repeated 7 times. */

  function schedulableItems() {
    // Dishes are tasted along the way; happenings are pinned to real dates — neither is
    // something the route builder should place for you
    return ((state.currentCity && state.currentCity.items) || []).filter(
      i => i.category !== "dish" && i.category !== "happening"
    );
  }

  // A day can carry its own hours; otherwise the default window applies
  function hoursForDay(day) {
    const custom = state.dayHours[day];
    return {
      start: (custom && custom.start) || state.dayStartTime,
      end: (custom && custom.end) || state.dayEndTime
    };
  }

  function dailyBudgetMinutes(day) {
    const { start, end } = day ? hoursForDay(day) : { start: state.dayStartTime, end: state.dayEndTime };
    return Math.max(180, parseTimeToMinutes(end) - parseTimeToMinutes(start));
  }

  function orderZonesGeographically(items) {
    const zones = [...new Set(items.map(i => i.zone).filter(Boolean))];
    const withLat = zones.map(zone => {
      const located = items.filter(i => i.zone === zone && typeof i.lat === "number");
      const avgLat = located.length
        ? located.reduce((sum, i) => sum + i.lat, 0) / located.length
        : null;
      return { zone, avgLat };
    });

    if (withLat.every(z => z.avgLat === null)) return zones;
    return withLat
      .sort((a, b) => (b.avgLat ?? -Infinity) - (a.avgLat ?? -Infinity))
      .map(z => z.zone);
  }

  // How many days each zone deserves, proportional to how much there is to do there
  function planZoneBlocks(totalDays) {
    const items = schedulableItems();
    if (!items.length) return [];

    const zoneOrder = orderZonesGeographically(items);
    if (!zoneOrder.length) return [{ zone: "", days: totalDays }];

    const budget = dailyBudgetMinutes();
    const weight = {};
    zoneOrder.forEach(zone => {
      weight[zone] = items
        .filter(i => i.zone === zone)
        .reduce((sum, i) => sum + Math.min(parseDurationToMinutes(i), budget), 0);
    });

    // Fewer days than zones: spend them on the richest zones, still in travel order
    if (totalDays <= zoneOrder.length) {
      const keep = [...zoneOrder].sort((a, b) => weight[b] - weight[a]).slice(0, totalDays);
      return zoneOrder.filter(z => keep.includes(z)).map(zone => ({ zone, days: 1 }));
    }

    const totalWeight = zoneOrder.reduce((sum, z) => sum + weight[z], 0) || 1;
    const alloc = zoneOrder.map(zone => {
      const exact = (weight[zone] / totalWeight) * totalDays;
      return { zone, days: Math.max(1, Math.floor(exact)), frac: exact - Math.floor(exact) };
    });

    let used = alloc.reduce((sum, a) => sum + a.days, 0);
    const byFraction = [...alloc].sort((a, b) => b.frac - a.frac);
    let i = 0;
    while (used < totalDays && byFraction.length) {
      byFraction[i % byFraction.length].days++;
      used++;
      i++;
    }
    while (used > totalDays) {
      const biggest = alloc.filter(a => a.days > 1).sort((a, b) => b.days - a.days)[0];
      if (!biggest) break;
      biggest.days--;
      used--;
    }

    return alloc.map(a => ({ zone: a.zone, days: a.days }));
  }

  // Must-sees anchor each day, then longer/marquee items, then the rest
  function priorityRank(item) {
    let rank = 0;
    if (item.mustVisit) rank -= 1000;
    if (item.popularOnSocials) rank -= 200;
    if (item.category === "visit") rank -= 50;
    return rank - Math.min(parseDurationToMinutes(item), 480) / 100;
  }

  function distanceBetween(a, b) {
    if (typeof a.lat !== "number" || typeof b.lat !== "number") return Infinity;
    const dLat = a.lat - b.lat;
    const dLng = (a.lng - b.lng) * Math.cos((a.lat * Math.PI) / 180);
    return Math.sqrt(dLat * dLat + dLng * dLng);
  }

  function buildOptimalItinerary(totalDays) {
    const itinerary = {};
    for (let d = 1; d <= totalDays; d++) itinerary[d] = [];

    const items = schedulableItems();
    if (!items.length) return itinerary;

    const budget = dailyBudgetMinutes();
    const blocks = planZoneBlocks(totalDays);
    let day = 1;

    blocks.forEach(block => {
      const pool = items
        .filter(i => (block.zone ? i.zone === block.zone : true))
        .sort((a, b) => priorityRank(a) - priorityRank(b));

      const blockEnd = day + block.days - 1;

      // Spread the zone's content evenly over its days rather than cramming the
      // first few and leaving the rest of the block empty
      const zoneMinutes = pool.reduce(
        (sum, i) => sum + Math.min(parseDurationToMinutes(i), budget),
        0
      );
      const perDayTarget = Math.min(
        budget,
        Math.max(150, Math.ceil(zoneMinutes / Math.max(1, block.days)))
      );

      while (day <= blockEnd && pool.length) {
        // A multi-day trip (an overnight cruise, the Ha Giang loop) takes the whole span
        if (isMultiDay(pool[0])) {
          const item = pool.shift();
          const span = Math.min(
            Math.max(1, Math.round(parseDurationToMinutes(item) / 1440)),
            blockEnd - day + 1
          );
          const entry = buildItineraryEntry(item);
          entry.spanDays = span;
          itinerary[day].push(entry);
          day += span;
          continue;
        }

        // Anchor the day with the highest-priority item, then hop to whatever is nearest
        let last = null;
        let used = 0;

        while (pool.length) {
          const headroom = last ? perDayTarget - used : budget;
          const candidates = pool.filter(
            i => !isMultiDay(i) && parseDurationToMinutes(i) <= headroom
          );
          if (!candidates.length) break;

          const next = last
            ? candidates.reduce((best, i) =>
                distanceBetween(last, i) < distanceBetween(last, best) ? i : best
              )
            : candidates[0];

          pool.splice(pool.indexOf(next), 1);
          itinerary[day].push(buildItineraryEntry(next));
          used += parseDurationToMinutes(next) + TRANSIT_BUFFER_MIN;
          last = next;
        }

        day++;
      }

      day = blockEnd + 1;
    });

    return itinerary;
  }

  // 4. Build the recommended plan for the current trip length
  function generateIdealItinerary() {
    if (!state.currentCity || !state.currentCity.items) return;

    state.itinerary = buildOptimalItinerary(state.tripDuration);
    rebuildPlannerTabs();
    renderItinerary();
    renderRecommendations();
  }

  // Opening a city: bring back the plan saved at the current trip length if there
  // is one, so a reload doesn't throw away what you built.
  function loadOrGenerateItinerary() {
    if (!state.currentCity || !state.currentCity.items) return;

    if (restoreDuration(state.tripDuration)) {
      adjustItineraryDays();
      rebuildPlannerTabs();
      renderItinerary();
      renderRecommendations();
      return;
    }

    generateIdealItinerary();
    snapshotDuration(state.tripDuration);
  }

  // 5. API key badge
  function updateApiBadge() {
    els.apiStatusBadge.classList.toggle("active", !!state.apiKey);
    els.apiStatusBadge.title = state.apiKey ? "Gemini key configured" : "Add your Gemini API key";
  }

  // 6. Top Nav Trip Tabs (pinned destination + cities with a saved itinerary)
  // Regions map onto a small set of named colour families rather than an
  // arbitrary index, so a city always reads the same way and the location
  // chips can inherit the tint of the region they sit in.
  // Sub-regions roll up into the three broad regions, so Sapa and Ha Giang sit
  // under Northern Vietnam rather than competing with it as a fourth region.
  function regionOf(zone) {
    if (!zone) return null;
    const z = zone.toLowerCase();
    if (z.includes("sapa") || z.includes("ha giang")) return "Northern Vietnam";
    return zone;
  }

  function zoneFamily(zone) {
    if (!zone) return null;
    const z = regionOf(zone).toLowerCase();
    if (z.includes("north")) return "north";
    if (z.includes("central")) return "central";
    if (z.includes("south")) return "south";

    // Any other city's zones fall back to a stable rotation through the same families
    if (!state.zoneOrderCache || state.zoneOrderCache.city !== (state.currentCity || {}).name) {
      const zones = [...new Set(((state.currentCity || {}).items || []).map(i => i.zone).filter(Boolean))];
      state.zoneOrderCache = { city: (state.currentCity || {}).name, zones };
    }
    const pool = ["north", "central", "south", "highlands"];
    const idx = state.zoneOrderCache.zones.indexOf(zone);
    return idx === -1 ? null : pool[idx % pool.length];
  }

  // Which region does a location (Hoi An, Sapa, …) belong to?
  function locationFamily(location) {
    if (!location || !state.currentCity) return null;
    const match = (state.currentCity.items || []).find(i => i.location === location && i.zone);
    return match ? zoneFamily(regionOf(match.zone)) : null;
  }

  function zoneChipMarkup(zone) {
    if (!zone) return "";
    const family = zoneFamily(zone);
    return `<span class="zone-chip" ${family ? `data-zone-family="${family}"` : ""}>${zone}</span>`;
  }

  function cityKeyFor(city) {
    return city.name.toLowerCase();
  }

  function itineraryHasItems(itinerary) {
    return Object.values(itinerary).some(dayItems => dayItems.length > 0);
  }

  function persistCurrentCityItinerary() {
    if (!state.currentCity) return;
    state.itineraryByCity[cityKeyFor(state.currentCity)] = {
      city: state.currentCity,
      tripDuration: state.tripDuration,
      itinerary: state.itinerary,
      weekSections: state.weekSections
    };
  }

  function renderTripTabs() {
    els.tripTabs.innerHTML = "";

    const pinnedCity = mockDestinations[PINNED_CITY_KEY];
    const tabs = [{ key: cityKeyFor(pinnedCity), name: pinnedCity.name, loadQuery: PINNED_CITY_KEY }];

    Object.keys(state.itineraryByCity).forEach(key => {
      if (key === tabs[0].key) return;
      const entry = state.itineraryByCity[key];
      if (!itineraryHasItems(entry.itinerary)) return;
      tabs.push({ key, name: entry.city.name, loadQuery: entry.city.name });
    });

    tabs.forEach(tab => {
      const btn = document.createElement("button");
      const isActive = state.currentCity && cityKeyFor(state.currentCity) === tab.key;
      btn.className = `trip-tab ${isActive ? "active" : ""}`;
      btn.innerHTML = `
        <span class="material-icons" style="font-size: 16px;">place</span>
        <span>${tab.name.split(",")[0]}</span>
      `;
      btn.addEventListener("click", () => {
        if (state.itineraryByCity[tab.key]) {
          openSavedCity(tab.key);
        } else {
          loadCity(tab.loadQuery);
        }
      });
      els.tripTabs.appendChild(btn);
    });
  }

  function resetFilters() {
    state.currentCategory = "all";
    state.filterZone = "all";
    state.filterLocation = "all";
    state.filterSocials = false;
    state.filterBookmarked = false;
    document.querySelectorAll(".anchor-chip").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.category === "all");
    });
    els.filterSocialsBtn.classList.remove("active");
    els.filterBookmarksBtn.classList.remove("active");
  }

  // Restore a previously visited city straight from cache (no re-fetch)
  function openSavedCity(cityKey) {
    const saved = state.itineraryByCity[cityKey];
    if (!saved) return;

    persistCurrentCityItinerary();

    state.currentCity = saved.city;
    state.tripDuration = saved.tripDuration;
    state.itinerary = saved.itinerary;
    state.weekSections = saved.weekSections || {};
    state.activeDay = 1;
    state.activeWeek = 1;
    els.tripDurationSelect.value = String(state.tripDuration);

    resetFilters();
    renderHero();
    renderFilterBars();
    rebuildPlannerTabs();
    renderItinerary();
    renderRecommendations();
  }

  // 7. Loader Visuals
  function showLoader(message = "Searching recommendations...") {
    els.recommendationsGrid.innerHTML = `
      <div class="loader-container">
        <div class="spinner"></div>
        <p>${message}</p>
      </div>
    `;
  }

  // 8. Load Destination Data
  async function loadCity(query) {
    const key = query.toLowerCase().trim();

    if (state.itineraryByCity[key]) {
      openSavedCity(key);
      return;
    }

    persistCurrentCityItinerary();
    resetFilters();

    if (mockDestinations[key]) {
      state.currentCity = mockDestinations[key];
      state.weekSections = {};
      state.activeDay = 1;
      state.activeWeek = 1;
      renderHero();
      renderFilterBars();
      loadOrGenerateItinerary();
      return;
    }

    if (!state.apiKey) {
      els.settingsModal.showModal();
      els.recommendationsGrid.innerHTML = `
        <div class="loader-container" style="text-align: center;">
          <span class="material-icons" style="font-size: 32px; color: var(--primary); margin-bottom: 0.5rem;">key</span>
          <h3>Gemini API Key Required</h3>
          <p style="max-width: 400px; margin-top: 0.25rem; font-size: 0.8rem; color: var(--muted);">To generate travel recommendations for "${query}" dynamically, add your Gemini key using the key icon in the top nav.</p>
        </div>
      `;
      return;
    }

    showLoader(`Asking Gemini to build ideal itinerary for ${query}...`);
    try {
      const liveData = await fetchLiveRecommendations(query);
      state.currentCity = liveData;
      state.weekSections = {};
      state.activeDay = 1;
      state.activeWeek = 1;
      renderHero();
      renderFilterBars();
      loadOrGenerateItinerary();
    } catch (error) {
      console.error(error);
      els.recommendationsGrid.innerHTML = `
        <div class="loader-container" style="text-align: center;">
          <span class="material-icons" style="font-size: 32px; color: var(--primary); margin-bottom: 0.5rem;">error_outline</span>
          <h3>Failed to Fetch Recommendations</h3>
          <p style="max-width: 400px; margin-top: 0.25rem; font-size: 0.8rem; color: var(--primary);">${error.message}</p>
        </div>
      `;
    }
  }

  // 8b. Hero with cover photo
  function getCoverImage() {
    if (!state.currentCity) return "";
    const custom = state.cityCovers[cityKeyFor(state.currentCity)];
    if (custom) return custom;
    if (state.currentCity.coverImage) return state.currentCity.coverImage;
    // Fall back to the first item that has a photo, so the hero always looks intentional
    const withImage = (state.currentCity.items || []).find(i => i.image);
    return withImage ? withImage.image : "";
  }

  function renderHero() {
    if (!state.currentCity) return;
    const city = state.currentCity;

    els.heroTitle.textContent = city.name;
    els.heroDesc.textContent = city.description || "";

    const cover = getCoverImage();
    els.cityHeroMedia.style.backgroundImage = cover ? `url("${cover}")` : "";
  }

  // 9. Gemini Live Connection
  /* Gemini's tool-enabled calls now live on the Interactions API; the older
     generateContent endpoint still works, so try the current one and fall back. */
  async function callGemini(promptText, { tools = [], json = false } = {}) {
    const headers = { "Content-Type": "application/json", "x-goog-api-key": state.apiKey };

    const interactions = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: GEMINI_MODEL,
        input: promptText,
        ...(tools.length ? { tools } : {})
      })
    }).catch(() => null);

    if (interactions && interactions.ok) {
      const data = await interactions.json();
      const text = extractGeminiText(data);
      if (text) return text;
    }

    // Fall back to the legacy endpoint (different tool spelling, same model)
    const legacyTools = tools
      .map(t => (t.type === "google_search" ? { googleSearch: {} } : t.type === "url_context" ? { urlContext: {} } : null))
      .filter(Boolean);

    const legacy = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${state.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }],
          ...(legacyTools.length ? { tools: legacyTools } : {}),
          ...(json && !legacyTools.length ? { generationConfig: { responseMimeType: "application/json" } } : {})
        })
      }
    );

    if (!legacy.ok) {
      const detail = await legacy.json().catch(() => ({}));
      throw new Error(detail.error?.message || `Gemini request failed (${legacy.status}).`);
    }

    const text = extractGeminiText(await legacy.json());
    if (!text) throw new Error("Gemini returned an empty response.");
    return text;
  }

  // Both API shapes bury the text in slightly different places
  function extractGeminiText(data) {
    if (!data) return "";
    if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text;

    const fromCandidates = data.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join("");
    if (fromCandidates) return fromCandidates;

    const fromOutput = Array.isArray(data.output)
      ? data.output
          .flatMap(o => (Array.isArray(o.content) ? o.content : []))
          .map(c => c.text)
          .filter(Boolean)
          .join("")
      : "";
    if (fromOutput) return fromOutput;

    return "";
  }

  // Grounded replies often wrap JSON in prose, so pull the payload out
  function parseJsonFromText(text, expectArray) {
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    try {
      return JSON.parse(cleaned);
    } catch (e) {
      const match = cleaned.match(expectArray ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/);
      if (!match) throw new Error("Couldn't read Gemini's response.");
      return JSON.parse(match[0]);
    }
  }

  async function fetchLiveRecommendations(cityName) {

    const promptText = `
      You are an expert travel planner. Generate a comprehensive travel list for "${cityName}".
      Your response MUST be a valid JSON object matching the exact structure below. Do not wrap it in markdown code blocks (\`\`\`json), just return the raw text.

      JSON Schema:
      {
        "name": "Full Location Name, Country",
        "description": "A rich 1-2 sentence description of the destination.",
        "items": [
          {
            "id": "item-1",
            "name": "Name of Attraction/Dish/Restaurant/Activity/Shop",
            "category": "visit",
            "subcategory": "Historical",
            "zone": "Geographical area/neighborhood or regional zone (e.g. 'Old Quarter', 'Shibuya', 'Central Vietnam', 'Left Bank')",
            "location": "Specific city or town name",
            "description": "Short description.",
            "duration": "Duration (e.g. 2h, 3h, Half Day)",
            "cost": "Cost in local currency with converted Indian Rupee (INR) value in parentheses, e.g., '100,000 VND (₹340)' or '500 JPY (₹270)' or 'Free'",
            "tip": "Insightful pro tip",
            "mustVisit": false,
            "popularOnSocials": false
          }
        ]
      }

      Generate 20 to 30 high-quality recommendation items, distributed across these 5 categories:
      1. "visit" (Places to Visit: subcategory must be "Historical", "Cultural", "Adventure", or "Modern")
      2. "dish" (Dishes to Try)
      3. "eat" (Places to Eat)
      4. "activity" (Activities to Do)
      5. "shopping" (Markets, boutiques, and craft shopping)

      Set "mustVisit": true ONLY for the handful of genuinely iconic, unmissable items (typically 4-8 of them).
      Set "popularOnSocials": true for places that are heavily photographed on Instagram/TikTok.

      Ensure that items are assigned to distinct regional "zone" values so the route can be optimized.

      Return ONLY the raw JSON object.
    `;

    const text = await callGemini(promptText, { json: true });
    return parseJsonFromText(text, false);
  }

  // 9b. Extract recommendations from an arbitrary link (Gemini reads the page server-side,
  // since a static page can't fetch most external URLs itself due to CORS)
  async function fetchLocationsFromLink(pageUrl) {
    const promptText = `
      Read the content at this URL: ${pageUrl}

      Extract a list of concrete, specific, real-world travel recommendations actually mentioned on
      this page — places to visit, activities/tours, dishes to try, restaurants/cafes, or shopping spots.
      Only include items that are genuinely named and described on the page. Do not invent items that
      aren't present on the page.

      Return ONLY a raw JSON array (no markdown fences, no surrounding text), with up to 15 items,
      each shaped exactly like:
      {
        "name": "Specific name",
        "category": "visit",
        "description": "A rich 1-2 sentence description drawn from the page content.",
        "zone": "Region if mentioned on the page, else an empty string",
        "location": "City or town if mentioned, else an empty string",
        "duration": "Rough time needed if the page suggests one (e.g. '2h'), else '1h'"
      }

      "category" must be exactly one of: "visit", "activity", "dish", "eat", "shopping".
      If the page has no concrete travel recommendations, return an empty array: []
    `;

    const text = await callGemini(promptText, { tools: [{ type: "url_context" }], json: true });
    const parsed = parseJsonFromText(text, true);
    return Array.isArray(parsed) ? parsed : [];
  }

  // 10. Filters
  function renderFilterBars() {
    const items = (state.currentCity && state.currentCity.items) || [];

    // The region row shows the broad regions only; sub-regions surface as locations
    const zones = [...new Set(items.map(i => regionOf(i.zone)).filter(Boolean))];

    // familyFor lets each chip carry its region's colour: the region chips get
    // the full tone, the location chips a lighter tint of the same family.
    function buildChips(container, values, activeValue, allLabel, onPick, familyFor) {
      container.innerHTML = "";
      if (!values.length) return;

      const label = document.createElement("span");
      label.className = "filter-group-label";
      label.textContent = allLabel;
      container.appendChild(label);

      const all = document.createElement("button");
      all.className = `filter-chip ${activeValue === "all" ? "active" : ""}`;
      all.textContent = "All";
      all.addEventListener("click", () => onPick("all"));
      container.appendChild(all);

      values.forEach(value => {
        const chip = document.createElement("button");
        chip.className = `filter-chip ${activeValue === value ? "active" : ""}`;
        chip.textContent = value;
        const family = familyFor ? familyFor(value) : null;
        if (family) chip.dataset.zoneFamily = family;
        chip.addEventListener("click", () => onPick(value));
        container.appendChild(chip);
      });
    }

    buildChips(els.zoneFilterBar, zones, state.filterZone, "Region", (value) => {
      state.filterZone = value;
      // A location outside the newly picked region would leave an empty grid
      state.filterLocation = "all";
      renderFilterBars();
      renderRecommendations();
    }, zoneFamily);

    // Locations stay out of the way until a region narrows them to a useful set
    if (state.filterZone === "all") {
      els.locationFilterBar.innerHTML = "";
      els.locationFilterBar.style.display = "none";
      return;
    }

    const locationPool = [...new Set(
      items.filter(i => regionOf(i.zone) === state.filterZone).map(i => i.location).filter(Boolean)
    )].sort();

    els.locationFilterBar.style.display = locationPool.length ? "flex" : "none";
    buildChips(els.locationFilterBar, locationPool, state.filterLocation, "Location", (value) => {
      state.filterLocation = value;
      renderFilterBars();
      renderRecommendations();
    }, locationFamily);
  }

  function passesFilters(item) {
    if (state.filterZone !== "all" && regionOf(item.zone) !== state.filterZone) return false;
    if (state.filterLocation !== "all" && item.location !== state.filterLocation) return false;
    if (state.filterSocials && !item.popularOnSocials) return false;
    if (state.filterBookmarked && !state.bookmarks.includes(item.id)) return false;
    return true;
  }

  // 11. Render Recommendations (photo-first card grid)
  // How many items of each category are already in the itinerary
  function selectedCountsByCategory() {
    const counts = {};
    Object.values(state.itinerary).forEach(dayItems => {
      dayItems.forEach(entry => {
        counts[entry.category] = (counts[entry.category] || 0) + 1;
      });
    });
    return counts;
  }

  // Counts live beside the section headings; repaint them in place so removing
  // an item from the planner updates the grid without a full re-render.
  function renderCategoryCounts() {
    const counts = selectedCountsByCategory();
    document.querySelectorAll("[data-section-count]").forEach(badge => {
      const n = counts[badge.dataset.sectionCount] || 0;
      badge.textContent = n ? String(n) : "";
      badge.style.display = n ? "inline-flex" : "none";
    });
  }

  function renderRecommendations() {
    els.recommendationsGrid.innerHTML = "";
    if (!state.currentCity || !state.currentCity.items.length) {
      els.recommendationsGrid.innerHTML = `<p class="text-muted">No recommendations found.</p>`;
      return;
    }

    const categoriesInfo = [
      { key: "visit", title: "Landmarks", description: "Sights, monuments and historic places" },
      { key: "activity", title: "Activities", description: "Things to do, experiences and tours" },
      { key: "eat", title: "Cafes & Restaurants", description: "Top local places to eat, drink and relax" },
      { key: "dish", title: "Dishes to Try", description: "Signature regional specialties and flavours" },
      { key: "shopping", title: "Shopping", description: "Markets, craft villages and boutiques" },
      { key: "happening", title: "While You're There", description: "Events and seasonal moments that land on your dates" }
    ];

    const activeCategories = categoriesInfo.filter(cat => {
      return state.currentCategory === "all" || cat.key === state.currentCategory;
    });

    let hasDisplayedAny = false;

    activeCategories.forEach(cat => {
      const items = state.currentCity.items.filter(item => item.category === cat.key && passesFilters(item));
      if (items.length === 0) return;
      hasDisplayedAny = true;

      const section = document.createElement("div");
      section.className = "recommendation-section";

      const sectionHeader = document.createElement("div");
      sectionHeader.className = "recommendation-section-header";
      sectionHeader.innerHTML = `
        <h3 class="recommendation-section-title">
          ${cat.title}
          <span class="section-count" data-section-count="${cat.key}" style="display: none;"></span>
        </h3>
        <p class="recommendation-section-desc">${cat.description}</p>
      `;
      section.appendChild(sectionHeader);

      const itemsList = document.createElement("div");
      itemsList.className = "recommendation-section-list";

      items.forEach(item => {
        itemsList.appendChild(buildRecommendationCard(item));
      });

      section.appendChild(itemsList);
      els.recommendationsGrid.appendChild(section);
    });

    if (!hasDisplayedAny) {
      const isFiltered = state.filterBookmarked || state.filterSocials ||
        state.filterZone !== "all" || state.filterLocation !== "all" || state.currentCategory !== "all";
      els.recommendationsGrid.innerHTML = `
        <div class="loader-container" style="text-align: center; padding: 4rem 2rem;">
          <span class="material-icons" style="font-size: 40px; color: var(--primary); margin-bottom: 0.5rem;">${state.filterBookmarked ? "favorite_border" : "filter_alt_off"}</span>
          <h3 style="font-weight: 700; font-size: 1.1rem; color: var(--ink);">${isFiltered ? "Nothing matches these filters" : "No recommendations found"}</h3>
          <p style="max-width: 340px; margin: 0.25rem auto 0; font-size: 0.8rem; color: var(--muted); line-height: 1.45;">
            ${state.filterBookmarked
              ? "Tap the heart on any card to save it here."
              : "Try clearing a filter or picking a different category."}
          </p>
        </div>
      `;
    }

    renderCategoryCounts();
  }

  function buildRecommendationCard(item) {
    const row = document.createElement("div");
    row.className = "todo-row";
    row.dataset.cat = item.category;

    const isHappening = item.category === "happening";

    const badges = [];
    if (item.zone) badges.push(zoneChipMarkup(item.zone));
    if (item.mustVisit) badges.push(`<span class="card-badge must-visit-badge">Must Visit</span>`);
    else if (!item.zone) badges.push(`<span class="card-badge">${CATEGORY_LABEL[item.category] || "Place"}</span>`);
    if (item.popularOnSocials) badges.push(`<span class="card-badge badge-social">🔥 Popular</span>`);
    if (item.imported) badges.push(`<span class="card-badge">✨ Imported</span>`);
    if (item.userAdded) badges.push(`<span class="card-badge">✍️ Yours</span>`);

    const scheduled = findScheduledEntry(item.id);
    const isBookmarked = state.bookmarks.includes(item.id);
    const hasNote = !!getNote(item.id);

    // Dishes are things to taste, not schedulable stops
    const showCheckbox = item.category !== "dish";
    const selectHtml = showCheckbox ? `
      <button class="todo-select ${scheduled ? "checked" : ""}" title="Toggle in ${scopeLabel()}">
        <span class="material-icons">check</span>
      </button>
    ` : "";

    const emoji = CATEGORY_EMOJI[item.category] || "📍";
    const edit = getCardEdit(item.id);
    const effectiveImage = edit.image || item.image;
    const effectiveDescription = edit.description || item.description;
    const isEdited = !!(edit.image || edit.description);

    const photoInner = effectiveImage
      ? `<img src="${effectiveImage}" alt="${item.name}" loading="lazy">`
      : `<div class="todo-photo-placeholder">${emoji}</div>`;

    // Place · type · time, split by hairlines
    const metaBits = [];
    if (item.location) metaBits.push(`<span><span class="material-icons">place</span>${item.location}</span>`);
    if (item.subcategory) metaBits.push(`<span><span class="material-icons">account_balance</span>${item.subcategory}</span>`);
    if (isHappening && item.dateLabel) {
      metaBits.push(`<span><span class="material-icons">event</span>${item.dateLabel}</span>`);
    } else {
      metaBits.push(`<span ${item.durationSource ? `title="${item.durationSource.replace(/"/g, "&quot;")}"` : ""}><span class="material-icons">schedule</span>${formatMinutes(parseDurationToMinutes(item))}</span>`);
    }

    row.innerHTML = `
      <div class="todo-photo">
        ${photoInner}
        ${selectHtml}
      </div>
      <div class="todo-body">
        ${badges.length ? `<div class="todo-header-row">${badges.join("")}</div>` : ""}
        <div class="todo-title-row">
          <h4 class="todo-title">${item.name}</h4>
          <button class="bookmark-btn ${isBookmarked ? "active" : ""}" title="${isBookmarked ? "Remove from bookmarks" : "Bookmark this item"}">
            <span class="material-icons" style="font-size: 19px;">${isBookmarked ? "favorite" : "favorite_border"}</span>
          </button>
        </div>
        <p class="todo-desc" title="Click to expand">${effectiveDescription || ""}</p>
        ${sourceChipMarkup(item)}
        ${item.whyNow ? `<p class="happening-why">${item.whyNow}</p>` : ""}
        <div class="todo-tipwrap">
          ${item.tip ? `<p class="todo-tip">${item.tip}</p>` : ""}
        </div>
        <div class="notes-box" data-note-box="${item.id}">
          <textarea placeholder="Jot a note for this…" data-note-input="${item.id}">${getNote(item.id)}</textarea>
        </div>
        <div class="todo-metarow">
          ${metaBits.join('<span class="metarow-sep"></span>')}
          ${item.tip ? `<button class="card-icon-btn metarow-tip" data-action="tip" title="Show the pro tip"><span class="material-icons">lightbulb</span></button>` : ""}
        </div>
        <div class="todo-footer">
          <div class="todo-meta">${formatCostMarkup(item.cost)}</div>
          <div class="todo-actions">
            <button class="card-icon-btn ${hasNote ? "active" : ""}" data-action="note" title="${hasNote ? "Edit your note" : "Add a note"}">
              <span class="material-icons">${hasNote ? "sticky_note_2" : "edit_note"}</span>
            </button>
            <button class="card-icon-btn ${isEdited ? "active" : ""}" data-action="edit" title="Edit image & description">
              <span class="material-icons">edit</span>
            </button>
          </div>
        </div>
      </div>
    `;

    row.querySelector(".bookmark-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleBookmark(item.id);
    });

    row.querySelector('[data-action="edit"]').addEventListener("click", (e) => {
      e.stopPropagation();
      openEditModal(item);
    });

    // Long descriptions stay clamped until asked for
    const desc = row.querySelector(".todo-desc");
    desc.addEventListener("click", () => desc.classList.toggle("expanded"));

    const tipBtn = row.querySelector('[data-action="tip"]');
    if (tipBtn) {
      const tip = row.querySelector(".todo-tip");
      tipBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        tip.classList.toggle("open");
        tipBtn.classList.toggle("active", tip.classList.contains("open"));
      });
    }

    const noteBtn = row.querySelector('[data-action="note"]');
    const noteBox = row.querySelector(`[data-note-box="${item.id}"]`);
    const noteInput = row.querySelector(`[data-note-input="${item.id}"]`);
    noteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      noteBox.classList.toggle("open");
      if (noteBox.classList.contains("open")) noteInput.focus();
    });
    noteInput.addEventListener("click", (e) => e.stopPropagation());
    noteInput.addEventListener("input", () => {
      saveNote(item.id, noteInput.value);
      const filled = !!noteInput.value.trim();
      noteBtn.classList.toggle("active", filled);
      noteBtn.querySelector(".material-icons").textContent = filled ? "sticky_note_2" : "edit_note";
    });

    if (showCheckbox) {
      row.querySelector(".todo-select").addEventListener("click", (e) => {
        e.stopPropagation();
        toggleItineraryItem(item);
      });
    }

    // Swap to a placeholder if the image URL fails to load
    const img = row.querySelector(".todo-photo img");
    if (img) {
      img.addEventListener("error", () => {
        const placeholder = document.createElement("div");
        placeholder.className = "todo-photo-placeholder";
        placeholder.textContent = emoji;
        img.replaceWith(placeholder);
      }, { once: true });
    }

    return row;
  }

  // Show the headline price boldly and any conversion in a lighter tail
  /* Prices in VND run to seven digits, which is a lot of zeros to read on a card.
     Shorten every number in a cost string to K/M at display time — the source
     data keeps its exact figures. */
  function abbreviateAmounts(text) {
    if (!text) return text;
    return text.replace(/\d[\d,]*/g, (raw) => {
      const n = parseInt(raw.replace(/,/g, ""), 10);
      // Only round thousands collapse. That covers every VND price (always whole
      // thousands) while leaving converted figures like ₹1,020 or ₹23,800 exact —
      // abbreviating those would both lose precision and mix units inside one
      // range, e.g. "₹850–₹1.4K".
      if (!Number.isFinite(n) || n < 1000 || n % 1000 !== 0) return raw;
      if (n >= 1000000) {
        const millions = Math.round((n / 1000000) * 10) / 10;
        return `${millions}M`;
      }
      return `${n / 1000}K`;
    });
  }

  /* ---------- Where an imported item came from ----------
     Simplified brand glyphs; Material Icons has no social marks. Each is a
     single path drawn on a 24-box so they all size and colour identically. */
  const PLATFORMS = {
    instagram: {
      name: "Instagram",
      color: "#E1306C",
      path: "M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41-.56-.22-.96-.48-1.38-.9-.42-.42-.68-.82-.9-1.38-.16-.42-.36-1.06-.41-2.23C2.17 15.58 2.16 15.2 2.16 12s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16zm0 3.18a6.66 6.66 0 100 13.32 6.66 6.66 0 000-13.32zm0 10.98a4.32 4.32 0 110-8.64 4.32 4.32 0 010 8.64zm8.48-11.24a1.56 1.56 0 11-3.11 0 1.56 1.56 0 013.11 0z"
    },
    pinterest: {
      name: "Pinterest",
      color: "#E60023",
      path: "M12 2C6.48 2 2 6.48 2 12c0 4.24 2.64 7.86 6.36 9.32-.09-.79-.17-2.01.03-2.88.18-.78 1.19-4.97 1.19-4.97s-.3-.61-.3-1.51c0-1.42.82-2.48 1.85-2.48.87 0 1.29.66 1.29 1.44 0 .88-.56 2.19-.85 3.41-.24 1.02.51 1.85 1.52 1.85 1.83 0 3.23-1.93 3.23-4.71 0-2.46-1.77-4.18-4.29-4.18-2.92 0-4.64 2.19-4.64 4.46 0 .88.34 1.83.76 2.35.08.1.1.19.07.29-.08.32-.25.98-.28 1.12-.05.19-.15.23-.35.14-1.3-.61-2.11-2.5-2.11-4.03 0-3.28 2.38-6.29 6.87-6.29 3.61 0 6.41 2.57 6.41 6.01 0 3.58-2.26 6.47-5.4 6.47-1.05 0-2.04-.55-2.38-1.2l-.65 2.47c-.23.91-.87 2.05-1.29 2.74.97.3 2 .46 3.07.46 5.52 0 10-4.48 10-10S17.52 2 12 2z"
    },
    reddit: {
      name: "Reddit",
      color: "#FF4500",
      path: "M22 12.07c0-1.23-1-2.23-2.23-2.23-.6 0-1.14.24-1.54.62-1.51-1.05-3.55-1.72-5.81-1.802l1.16-3.65 3.13.74a1.79 1.79 0 103.55-.23 1.79 1.79 0 00-3.42-.53l-3.5-.83a.46.46 0 00-.55.31l-1.32 4.16c-2.36.05-4.5.72-6.07 1.8a2.21 2.21 0 00-1.54-.62A2.23 2.23 0 002 12.07c0 .87.5 1.62 1.23 1.99a4.1 4.1 0 00-.05.65C3.18 18.2 7.12 21 12 21s8.82-2.8 8.82-6.29c0-.22-.02-.44-.05-.65A2.23 2.23 0 0022 12.07zM7.5 13.68a1.6 1.6 0 113.2 0 1.6 1.6 0 01-3.2 0zm8.98 4.28c-1.1 1.1-3.2 1.18-3.82 1.18-.62 0-2.73-.08-3.82-1.18a.42.42 0 01.6-.6c.69.7 2.18.94 3.22.94s2.53-.25 3.22-.94a.42.42 0 01.6.6zm-.19-2.68a1.6 1.6 0 110-3.2 1.6 1.6 0 010 3.2z"
    },
    tiktok: {
      name: "TikTok",
      color: "#010101",
      path: "M16.6 5.82A4.28 4.28 0 0115.54 3h-3.09v12.4a2.59 2.59 0 01-2.59 2.5 2.59 2.59 0 01-2.59-2.59 2.59 2.59 0 012.59-2.59c.27 0 .53.04.77.12v-3.1a5.7 5.7 0 00-.77-.05A5.68 5.68 0 004.18 15.4 5.68 5.68 0 009.86 21a5.68 5.68 0 005.68-5.6V9.01a7.35 7.35 0 004.28 1.37V7.29a4.28 4.28 0 01-3.22-1.47z"
    },
    youtube: {
      name: "YouTube",
      color: "#FF0000",
      path: "M21.58 7.19a2.5 2.5 0 00-1.77-1.77C18.25 5 12 5 12 5s-6.25 0-7.81.42a2.5 2.5 0 00-1.77 1.77A26.1 26.1 0 002 12a26.1 26.1 0 00.42 4.81 2.5 2.5 0 001.77 1.77C5.75 19 12 19 12 19s6.25 0 7.81-.42a2.5 2.5 0 001.77-1.77A26.1 26.1 0 0022 12a26.1 26.1 0 00-.42-4.81zM10 15.02V8.98L15.2 12 10 15.02z"
    },
    x: {
      name: "X",
      color: "#0f1419",
      path: "M13.9 10.6L20.4 3h-1.54l-5.65 6.6L8.7 3H3.5l6.83 9.94L3.5 21h1.54l5.97-6.97L15.78 21h5.2l-7.08-10.4zm-2.11 2.47l-.7-.99L5.6 4.17h2.37l4.44 6.35.7.99 5.78 8.26h-2.37l-4.72-6.7z"
    },
    facebook: {
      name: "Facebook",
      color: "#1877F2",
      path: "M22 12a10 10 0 10-11.56 9.88v-6.99H7.9V12h2.54V9.8c0-2.5 1.49-3.89 3.77-3.89 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56V12h2.78l-.45 2.89h-2.33v6.99A10 10 0 0022 12z"
    },
    tripadvisor: {
      name: "Tripadvisor",
      color: "#00AF87",
      path: "M12 6.5c-2.6 0-5.02.7-7.06 1.9H1l1.66 1.81A4.84 4.84 0 006.5 18.5a4.82 4.82 0 003.4-1.4L12 19.3l2.1-2.19a4.82 4.82 0 003.4 1.4 4.84 4.84 0 003.84-8.3L23 8.4h-3.94A13.63 13.63 0 0012 6.5zm-5.5 9.9a3.4 3.4 0 110-6.8 3.4 3.4 0 010 6.8zm11 0a3.4 3.4 0 110-6.8 3.4 3.4 0 010 6.8zm-11-5.1a1.7 1.7 0 100 3.4 1.7 1.7 0 000-3.4zm11 0a1.7 1.7 0 100 3.4 1.7 1.7 0 000-3.4z"
    }
  };

  // A generic mark for anything we don't recognise (blogs, news, guides)
  const GENERIC_PLATFORM = {
    name: "Link",
    color: "#6b6b6b",
    path: "M10.6 13.4a1 1 0 001.42 0l3.54-3.54a2.5 2.5 0 10-3.54-3.54l-.7.71 1.41 1.41.71-.7a.5.5 0 01.71.7l-3.54 3.54a.5.5 0 01-.7 0 1 1 0 00-1.31 1.42zm2.8-2.8a1 1 0 00-1.42 0l-3.54 3.54a2.5 2.5 0 103.54 3.54l.7-.71-1.41-1.41-.71.7a.5.5 0 01-.71-.7l3.54-3.54a.5.5 0 01.7 0 1 1 0 001.31-1.42z"
  };

  // Work out which site a pasted link came from
  function detectPlatform(url) {
    if (!url) return null;
    let host;
    try {
      host = new URL(url.startsWith("http") ? url : `https://${url}`).hostname.toLowerCase();
    } catch (e) {
      return null;
    }
    host = host.replace(/^www\./, "");

    const map = [
      ["instagram", ["instagram.com", "instagr.am"]],
      ["pinterest", ["pinterest.com", "pin.it", "pinterest.co.uk", "pinterest.ca"]],
      ["reddit", ["reddit.com", "redd.it"]],
      ["tiktok", ["tiktok.com", "vm.tiktok.com"]],
      ["youtube", ["youtube.com", "youtu.be", "m.youtube.com"]],
      ["x", ["twitter.com", "x.com", "t.co"]],
      ["facebook", ["facebook.com", "fb.com", "fb.watch"]],
      ["tripadvisor", ["tripadvisor.com", "tripadvisor.co.uk", "tripadvisor.in"]]
    ];

    for (const [key, hosts] of map) {
      if (hosts.some(h => host === h || host.endsWith(`.${h}`))) {
        return { key, ...PLATFORMS[key] };
      }
    }
    // Unrecognised: still worth showing, labelled by its domain
    return { key: "link", ...GENERIC_PLATFORM, name: host };
  }

  // The chip under the description, linking back to where the item came from
  function sourceChipMarkup(item) {
    if (!item.sourceUrl) return "";
    const p = detectPlatform(item.sourceUrl);
    if (!p) return "";
    return `
      <a class="source-chip" href="${item.sourceUrl}" target="_blank" rel="noopener noreferrer"
         title="Opens ${p.name} in a new tab" onclick="event.stopPropagation()">
        <svg viewBox="0 0 24 24" aria-hidden="true" style="fill: ${p.color}"><path d="${p.path}"/></svg>
        <span>${p.name}</span>
      </a>
    `;
  }

  function formatCostMarkup(cost) {
    if (!cost || cost === "—") return `<span class="cost-main">Free</span>`;
    const short = abbreviateAmounts(cost);
    const match = short.match(/^(.*?)\s*(\(.*\))\s*$/);
    if (!match) return `<span class="cost-main">${short}</span>`;
    return `<span class="cost-main">${match[1]}</span> <span class="cost-sub">${match[2]}</span>`;
  }

  function toggleBookmark(itemId) {
    const index = state.bookmarks.indexOf(itemId);
    if (index > -1) {
      state.bookmarks.splice(index, 1);
    } else {
      state.bookmarks.push(itemId);
    }
    localStorage.setItem("detour_bookmarks", JSON.stringify(state.bookmarks));
    renderRecommendations();
  }

  // Adds/removes within the current scope (a day, or anywhere in the active week)
  function toggleItineraryItem(item) {
    const scheduled = findScheduledEntry(item.id);

    if (scheduled) {
      state.itinerary[scheduled.day].splice(scheduled.index, 1);
    } else {
      const day = targetDayForAdd();
      if (!state.itinerary[day]) state.itinerary[day] = [];
      state.itinerary[day].push(buildItineraryEntry(item));
      // Open the day it landed on so the addition is visible
      state.dayCollapsed = false;
    }

    renderItinerary();
    renderRecommendations();
  }

  // 12. Render Itinerary (right panel)
  function renderItinerary() {
    persistCurrentCityItinerary();
    renderTripTabs();
    updateRailCount();

    // Sections are a week-view concept, and only make sense in the list
    els.weekSectionRow.style.display = state.planMode === "week" ? "flex" : "none";

    els.itineraryList.innerHTML = "";

    if (state.planMode === "week") {
      renderWeekList();
    } else {
      renderDayList();
    }

    updateItineraryColumns();
    renderMapView();
    renderCategoryCounts();
    // Rows were just rebuilt, so re-attach any nudges we already know about
    paintNudgeChips();
    scheduleWeatherRefresh();
  }

  // Reflow the itinerary into 2 or 3 columns once the panel is wide enough for them
  function updateItineraryColumns() {
    const width = els.itineraryList.clientWidth;
    const cls = width >= 820 ? "cols-3" : width >= 540 ? "cols-2" : "";

    /* The planner column is resized by dragging the split, so its width is
       independent of the viewport — a media query can't see it. Measure it here
       and let the toolbar rows stack deliberately instead of wrapping by luck. */
    const col = document.getElementById("plan-main-col");
    if (col) col.classList.toggle("compact", col.clientWidth < 660);

    // In day-wise mode the columns belong to the open day's body, not the accordion stack
    const targets = state.planMode === "week"
      ? [els.itineraryList]
      : [...els.itineraryList.querySelectorAll(".day-acc-body")];

    els.itineraryList.classList.remove("cols-2", "cols-3");
    if (state.planMode === "week" && cls) els.itineraryList.classList.add(cls);

    targets.forEach(t => {
      t.classList.remove("cols-2", "cols-3");
      if (cls) t.classList.add(cls);
    });
  }

  // Coalesce weather lookups so a burst of re-renders makes one request round
  let weatherTimer = null;
  function scheduleWeatherRefresh() {
    if (!state.tripStartDate) return;
    clearTimeout(weatherTimer);
    weatherTimer = setTimeout(renderWeatherOutlook, 600);
  }

  function updateRailCount() {
    const total = Object.values(state.itinerary).reduce((sum, day) => sum + day.length, 0);
    els.plannerRailCount.textContent = total;
    updateViewSwitchCount();
  }

  function renderEmptyState(message) {
    els.itineraryList.innerHTML = `
      <div class="itinerary-empty-state">
        <span class="material-icons" style="opacity: 0.5;">event_note</span>
        <p>${message}</p>
      </div>
    `;
  }

  // Day-wise: a timeline with real clock times
  // A multi-day item started on an earlier day may still be running today
  function ongoingMultiDayEntry(day) {
    for (let d = day - 1; d >= 1; d--) {
      const match = (state.itinerary[d] || []).find(
        e => e.spanDays > 1 && d + e.spanDays - 1 >= day
      );
      if (match) return { entry: match, startDay: d };
    }
    return null;
  }

  // Day-wise is an accordion of days; the active one is open
  function renderDayList() {
    for (let day = 1; day <= state.tripDuration; day++) {
      const isOpen = day === state.activeDay && !state.dayCollapsed;
      const acc = document.createElement("div");
      acc.className = `day-acc ${isOpen ? "open" : ""}`;

      const count = (state.itinerary[day] || []).length;
      const head = document.createElement("div");
      head.className = "day-acc-head";
      const mapped = (state.itinerary[day] || []).some(e => typeof e.lat === "number");
      head.innerHTML = `
        ${mapped ? `
          <label class="day-pin-toggle" title="Show Day ${day} pins on the map">
            <input type="checkbox" ${dayPinsVisible(day) ? "checked" : ""} data-day-pins="${day}">
            <span class="day-pin-box"><span class="material-icons">check</span></span>
          </label>` : `<span class="day-pin-spacer"></span>`}
        <span class="day-acc-num">Day ${day}</span>
        <span class="day-acc-date">${dayDateLabel(day)}</span>
        <span class="nudge-slot" data-nudge-day="${day}"></span>
        ${count ? `<span class="day-acc-count">${count}</span>` : ""}
        <span class="day-acc-chevron material-icons" style="font-size: 18px;">expand_more</span>
      `;
      // The checkbox filters map pins; it must not also open or close the day
      const pinToggle = head.querySelector("[data-day-pins]");
      if (pinToggle) {
        pinToggle.addEventListener("click", (e) => e.stopPropagation());
        pinToggle.addEventListener("change", (e) => {
          e.stopPropagation();
          toggleDayPins(day);
        });
      }
      const pinLabel = head.querySelector(".day-pin-toggle");
      if (pinLabel) pinLabel.addEventListener("click", (e) => e.stopPropagation());

      head.addEventListener("click", () => {
        // Clicking the open day collapses it. activeDay stays put so adds and
        // drags still have a target day; only the accordion closes.
        if (state.activeDay === day) {
          state.dayCollapsed = !state.dayCollapsed;
        } else {
          state.activeDay = day;
          state.activeWeek = weekOfDay(day);
          state.dayCollapsed = false;
        }
        renderItinerary();
        renderRecommendations();
      });
      acc.appendChild(head);

      if (isOpen) {
        const body = document.createElement("div");
        body.className = "day-acc-body";
        buildDayBody(day, body);
        acc.appendChild(body);
      }

      els.itineraryList.appendChild(acc);
    }
  }

  // The real calendar date for a trip day, when travel dates are set
  function dayDateLabel(day) {
    if (!state.tripStartDate) return `Week ${weekOfDay(day)}`;
    const start = new Date(`${state.tripStartDate}T00:00:00`);
    if (Number.isNaN(start.getTime())) return "";
    const d = new Date(start);
    d.setDate(start.getDate() + day - 1);
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", weekday: "short" });
  }

  function buildDayBody(day, container) {
    container.appendChild(buildDayHoursRow(day));

    const items = state.itinerary[day] || [];
    const ongoing = ongoingMultiDayEntry(day);

    if (ongoing) {
      const dayNumber = day - ongoing.startDay + 1;
      const banner = document.createElement("div");
      banner.className = "multiday-banner";
      banner.innerHTML = `
        <span class="material-icons" style="font-size: 16px;">schedule</span>
        <div>
          <strong>${ongoing.entry.name}</strong>
          <span>Day ${dayNumber} of ${ongoing.entry.spanDays} — continues from Day ${ongoing.startDay}</span>
        </div>
      `;
      container.appendChild(banner);
    }

    const hours = hoursForDay(day);
    let runningMinutes = parseTimeToMinutes(hours.start);
    const dayEndMinutes = parseTimeToMinutes(hours.end);

    items.forEach((item, index) => {
      const div = document.createElement("div");
      div.className = "itinerary-todo-row";
      div.dataset.cat = item.category;
      div.dataset.itemId = item.id;
      div.setAttribute("draggable", "true");

      const durationMin = parseDurationToMinutes(item);

      // Multi-day items get a label instead of a clock slot and don't consume the day
      let clockLabel;
      let isOvertime = false;
      if (isMultiDay(item)) {
        clockLabel = "Multi-day";
      } else {
        isOvertime = runningMinutes > dayEndMinutes;
        clockLabel = formatClock(runningMinutes);
        runningMinutes += durationMin + TRANSIT_BUFFER_MIN;
      }

      if (isOvertime) div.classList.add("overtime");

      const overtimeHtml = isOvertime
        ? `<span class="itinerary-overtime-badge" title="Runs past your hours for this day (${hours.end})"><span class="material-icons">warning</span>Past hours</span>`
        : "";
      const linkHtml = item.link
        ? `<a class="itinerary-todo-link" href="${item.link}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()"><span class="material-icons">open_in_new</span>Map link</a>`
        : "";

      div.innerHTML = `
        <div class="itinerary-todo-rail">
          <span class="itinerary-todo-clock">${clockLabel}</span>
          <span class="itinerary-todo-dot"></span>
          <span class="itinerary-todo-line"></span>
        </div>
        <div class="itinerary-todo-card">
          ${itineraryThumbMarkup(item)}
          <div class="itinerary-todo-info">
            <span class="itinerary-todo-title">${item.name}</span>
            <div style="display: flex; align-items: center; gap: 0.4rem; margin-top: 0.2rem; flex-wrap: wrap;">
              <span class="itinerary-clock-chip">${clockLabel}</span>
              <span class="itinerary-todo-meta">⏱️ ${formatMinutes(durationMin)}</span>
              ${item.zone ? zoneChipMarkup(item.zone) : ""}
              ${nudgeSlotMarkup(item, day)}
              ${linkHtml}
              ${overtimeHtml}
            </div>
          </div>
          <button class="remove-itinerary-item-btn" title="Remove">
            <span class="material-icons" style="font-size: 15px;">close</span>
          </button>
        </div>
      `;

      div.addEventListener("dragstart", (e) => {
        div.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
      });

      div.addEventListener("dragend", () => {
        div.classList.remove("dragging");
        saveItineraryDragOrder();
      });

      div.querySelector(".remove-itinerary-item-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        state.itinerary[day].splice(index, 1);
        renderItinerary();
        renderRecommendations();
      });

      // Tapping the card opens the full detail
      div.querySelector(".itinerary-todo-card").addEventListener("click", () => openItemDetail(item));

      container.appendChild(div);
    });

    if (!items.length && !ongoing) {
      const empty = document.createElement("div");
      empty.className = "week-section-empty";
      empty.textContent = "Nothing planned yet for this day.";
      container.appendChild(empty);
    }

    const addBtn = document.createElement("button");
    addBtn.className = "day-add-place";
    addBtn.innerHTML = `<span class="material-icons" style="font-size: 16px;">add</span>Add a place`;
    addBtn.addEventListener("click", () => {
      // Jump to the browse grid so the next thing ticked lands on this day
      state.activeDay = day;
      state.dayCollapsed = false;
      setViewMode("explore");
      requestAnimationFrame(() => {
        els.recommendationsGrid.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
    container.appendChild(addBtn);
  }

  // Small photo beside an itinerary row, taken from the source card
  function itineraryThumbMarkup(entry) {
    const source = sourceItemFor(entry);
    const edit = getCardEdit(entry.id);
    const image = edit.image || source.image;
    const emoji = CATEGORY_EMOJI[entry.category] || "📍";
    return image
      ? `<div class="itinerary-thumb"><img src="${image}" alt="" loading="lazy"></div>`
      : `<div class="itinerary-thumb">${emoji}</div>`;
  }

  // Hours are opt-in per day rather than a global setting
  function buildDayHoursRow(day) {
    const row = document.createElement("div");
    row.className = "day-hours-row";
    const custom = state.dayHours[day];

    if (!custom) {
      row.innerHTML = `
        <button class="day-hours-add" data-action="add-hours">
          <span class="material-icons">schedule</span>
          Set hours for Day ${day}
        </button>
      `;
      row.querySelector('[data-action="add-hours"]').addEventListener("click", () => {
        state.dayHours[day] = { start: "09:00", end: "21:00" };
        persistDayHours();
        renderItinerary();
      });
      return row;
    }

    row.innerHTML = `
      <span class="planner-duration-label" style="font-size: 0.72rem;">Day ${day}</span>
      <input type="time" class="planner-time-input" data-role="start" value="${custom.start}">
      <span class="planner-duration-label" style="font-weight: 500;">–</span>
      <input type="time" class="planner-time-input" data-role="end" value="${custom.end}">
      <button class="day-hours-clear" title="Remove hours for this day">
        <span class="material-icons" style="font-size: 15px;">close</span>
      </button>
    `;

    row.querySelector('[data-role="start"]').addEventListener("change", (e) => {
      state.dayHours[day].start = e.target.value || "09:00";
      persistDayHours();
      renderItinerary();
    });
    row.querySelector('[data-role="end"]').addEventListener("change", (e) => {
      state.dayHours[day].end = e.target.value || "21:00";
      persistDayHours();
      renderItinerary();
    });
    row.querySelector(".day-hours-clear").addEventListener("click", () => {
      delete state.dayHours[day];
      persistDayHours();
      renderItinerary();
    });

    return row;
  }

  function persistDayHours() {
    localStorage.setItem("detour_day_hours", JSON.stringify(state.dayHours));
  }

  // Week-wise: simple cards, no clock — a high-level view of the week
  function renderWeekList() {
    const days = daysInWeek(state.activeWeek);
    const entries = scopeEntries();
    const sections = sectionsForWeek(state.activeWeek);

    if (entries.length === 0 && sections.length === 0) {
      renderEmptyState(`Week ${state.activeWeek} is empty.<br>Add ideas now, pin them to days later.`);
      return;
    }

    const header = document.createElement("div");
    header.className = "week-group-header";
    header.textContent = `${entries.length} planned · Day ${days[0]}–${days[days.length - 1]}`;
    els.itineraryList.appendChild(header);

    const groups = sections.map(section => ({
      section,
      entries: entries.filter(e => e.entry.sectionId === section.id)
    }));

    const loose = entries.filter(e => !sections.some(s => s.id === e.entry.sectionId));
    groups.push({ section: null, entries: loose });

    groups.forEach(group => {
      if (!group.section && group.entries.length === 0) return;

      const wrapper = document.createElement("div");
      wrapper.className = "week-section";
      wrapper.dataset.sectionId = group.section ? group.section.id : "";

      if (group.section) {
        wrapper.appendChild(buildSectionHeader(group.section, group.entries.length, days));
      } else if (sections.length > 0 && group.entries.length > 0) {
        const head = document.createElement("div");
        head.className = "week-group-header";
        head.textContent = "Unsectioned";
        wrapper.appendChild(head);
      }

      const cardHolder = document.createElement("div");
      cardHolder.className = "week-section-cards";
      group.entries.forEach(({ entry, day, index }) => {
        cardHolder.appendChild(buildWeekCard(entry, day, index, days, sections));
      });
      if (group.section && group.entries.length === 0) {
        const empty = document.createElement("div");
        empty.className = "week-section-empty";
        empty.textContent = "Drop items here, or use the section dropdown.";
        cardHolder.appendChild(empty);
      }
      wrapper.appendChild(cardHolder);

      wireSectionDropTarget(wrapper, group.section);
      els.itineraryList.appendChild(wrapper);
    });
  }

  // A section can cover part of the week (e.g. the first half)
  function buildSectionHeader(section, count, days) {
    const head = document.createElement("div");
    head.className = "week-section-header";

    const from = section.fromDay || days[0];
    const to = section.toDay || days[days.length - 1];
    const dayOptions = (selected) =>
      days.map(d => `<option value="${d}" ${d === selected ? "selected" : ""}>Day ${d}</option>`).join("");

    head.innerHTML = `
      <span class="week-section-name">${section.name}</span>
      <span class="week-section-range">
        <select data-role="from">${dayOptions(from)}</select>
        <span>→</span>
        <select data-role="to">${dayOptions(to)}</select>
      </span>
      <span class="week-section-count">${count}</span>
      <button class="week-section-btn" data-action="rename" title="Rename section">
        <span class="material-icons" style="font-size: 14px;">edit</span>
      </button>
      <button class="week-section-btn" data-action="delete" title="Remove section">
        <span class="material-icons" style="font-size: 15px;">close</span>
      </button>
    `;

    head.querySelector('[data-role="from"]').addEventListener("change", (e) => {
      section.fromDay = parseInt(e.target.value, 10);
      if (section.toDay && section.toDay < section.fromDay) section.toDay = section.fromDay;
      applySectionRange(section, days);
    });
    head.querySelector('[data-role="to"]').addEventListener("change", (e) => {
      section.toDay = parseInt(e.target.value, 10);
      if (section.fromDay && section.fromDay > section.toDay) section.fromDay = section.toDay;
      applySectionRange(section, days);
    });
    head.querySelector('[data-action="rename"]').addEventListener("click", () =>
      renameSection(state.activeWeek, section.id)
    );
    head.querySelector('[data-action="delete"]').addEventListener("click", () =>
      deleteSection(state.activeWeek, section.id)
    );

    return head;
  }

  // Pull anything in this section back inside its day range
  function applySectionRange(section, days) {
    const from = section.fromDay || days[0];
    const to = section.toDay || days[days.length - 1];

    days.forEach(day => {
      const list = state.itinerary[day] || [];
      for (let i = list.length - 1; i >= 0; i--) {
        const entry = list[i];
        if (entry.sectionId !== section.id) continue;
        if (day >= from && day <= to) continue;
        const [moved] = list.splice(i, 1);
        if (!state.itinerary[from]) state.itinerary[from] = [];
        state.itinerary[from].push(moved);
      }
    });

    renderItinerary();
  }

  // Dropping a card on a section files it there (and into the section's day range)
  function wireSectionDropTarget(wrapper, section) {
    wrapper.addEventListener("dragover", (e) => {
      if (!draggedWeekEntry) return;
      e.preventDefault();
      wrapper.classList.add("drop-target");
    });

    wrapper.addEventListener("dragleave", (e) => {
      if (!wrapper.contains(e.relatedTarget)) wrapper.classList.remove("drop-target");
    });

    wrapper.addEventListener("drop", (e) => {
      e.preventDefault();
      wrapper.classList.remove("drop-target");
      if (!draggedWeekEntry) return;

      const { entry, day } = draggedWeekEntry;
      if (section) {
        entry.sectionId = section.id;
        const days = daysInWeek(state.activeWeek);
        const from = section.fromDay || days[0];
        const to = section.toDay || days[days.length - 1];
        if (day < from || day > to) {
          const list = state.itinerary[day] || [];
          const idx = list.indexOf(entry);
          if (idx > -1) list.splice(idx, 1);
          if (!state.itinerary[from]) state.itinerary[from] = [];
          state.itinerary[from].push(entry);
        }
      } else {
        delete entry.sectionId;
      }

      draggedWeekEntry = null;
      renderItinerary();
    });
  }

  function buildWeekCard(entry, day, index, days, sections) {
    const card = document.createElement("div");
    card.className = "week-card";
    card.dataset.cat = entry.category;
    card.setAttribute("draggable", "true");

    const categoryEmoji = CATEGORY_EMOJI[entry.category] || "📍";
    const linkHtml = entry.link
      ? `<a class="itinerary-todo-link" href="${entry.link}" target="_blank" rel="noopener noreferrer"><span class="material-icons">open_in_new</span>Map link</a>`
      : "";

    const dayOptions = days
      .map(d => `<option value="${d}" ${d === day ? "selected" : ""}>Day ${d}</option>`)
      .join("");

    const sectionOptions = sections.length
      ? `<select class="week-section-select week-day-chip" title="Move to a section">
           <option value="">No section</option>
           ${sections
             .map(s => `<option value="${s.id}" ${entry.sectionId === s.id ? "selected" : ""}>${s.name}</option>`)
             .join("")}
         </select>`
      : "";

    card.innerHTML = `
      <div class="week-card-main">
        <span class="week-card-title">${categoryEmoji} ${entry.name}</span>
        <div class="week-card-meta">
          <select class="week-day-select week-day-chip" title="Move to another day">${dayOptions}</select>
          ${sectionOptions}
          <span>⏱️ ${formatMinutes(parseDurationToMinutes(entry))}</span>
          ${entry.zone ? zoneChipMarkup(entry.zone) : ""}
          ${nudgeSlotMarkup(entry, day)}
          ${linkHtml}
        </div>
      </div>
      <button class="remove-itinerary-item-btn" title="Remove">
        <span class="material-icons" style="font-size: 15px;">close</span>
      </button>
    `;

    card.addEventListener("dragstart", (e) => {
      draggedWeekEntry = { entry, day };
      card.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      draggedWeekEntry = null;
    });

    card.querySelector(".week-day-select").addEventListener("change", (e) => {
      e.stopPropagation();
      const newDay = parseInt(e.target.value, 10);
      if (newDay === day) return;
      const [moved] = state.itinerary[day].splice(index, 1);
      if (!state.itinerary[newDay]) state.itinerary[newDay] = [];
      state.itinerary[newDay].push(moved);
      renderItinerary();
    });

    const sectionSelect = card.querySelector(".week-section-select");
    if (sectionSelect) {
      sectionSelect.addEventListener("change", (e) => {
        e.stopPropagation();
        if (e.target.value) entry.sectionId = e.target.value;
        else delete entry.sectionId;
        renderItinerary();
      });
    }
    card.querySelectorAll("select").forEach(sel => sel.addEventListener("click", e => e.stopPropagation()));

    card.querySelector(".remove-itinerary-item-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      state.itinerary[day].splice(index, 1);
      renderItinerary();
      renderRecommendations();
    });

    // Tapping the card opens the full detail
    card.querySelector(".week-card-main").addEventListener("click", () => openItemDetail(entry));

    return card;
  }

  // 12b. Itinerary Map (Leaflet pins for the day or week in view)
  /* OpenStreetMap's public tiles are explicitly light-use only and the
     foundation blocks clients without notice, which leaves the map blank. Keep
     a list of key-free providers and fail over to the next one when tiles
     start erroring, so a block degrades the basemap rather than the feature. */
  const TILE_PROVIDERS = [
    {
      name: "OpenStreetMap",
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      options: { maxZoom: 19, attribution: "© OpenStreetMap" }
    },
    {
      name: "Carto Voyager",
      url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      options: {
        maxZoom: 20,
        subdomains: "abcd",
        attribution: "© OpenStreetMap · © CARTO"
      }
    },
    {
      name: "Esri World Street Map",
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
      options: { maxZoom: 19, attribution: "© Esri" }
    }
  ];

  let tileProviderIndex = 0;
  let tileLayer = null;

  function mountTileLayer(map) {
    const provider = TILE_PROVIDERS[tileProviderIndex];
    if (!provider) return;

    if (tileLayer) map.removeLayer(tileLayer);
    tileLayer = L.tileLayer(provider.url, provider.options).addTo(map);

    /* A provider that errors while having served nothing is refusing us; one
       that errors after some successes is just missing the odd tile. Counting
       raw errors alone is unreliable, because only a handful of tiles are in
       view at a time. */
    let loaded = 0;
    let errors = 0;
    let switched = false;

    const failOver = () => {
      if (switched) return;
      if (tileProviderIndex >= TILE_PROVIDERS.length - 1) return;
      switched = true;
      tileProviderIndex++;
      console.warn(
        `Tiles from ${provider.name} are not loading — falling back to ${TILE_PROVIDERS[tileProviderIndex].name}.`
      );
      mountTileLayer(map);
    };

    tileLayer.on("tileload", () => { loaded++; });

    tileLayer.on("tileerror", () => {
      errors++;
      if (loaded === 0 && errors >= 2) failOver();   // blocked outright
      else if (errors >= 8) failOver();              // degrading badly
    });
  }

  function ensureMap() {
    if (mapInstance) return mapInstance;
    mapInstance = L.map(els.itineraryMap, { zoomControl: true, attributionControl: false });
    mapMarkersLayer = L.layerGroup().addTo(mapInstance);
    mountTileLayer(mapInstance);
    return mapInstance;
  }

  function scopeLabel() {
    return state.planMode === "week" ? `Week ${state.activeWeek}` : `Day ${state.activeDay}`;
  }

  let currentMapBounds = [];

  function fitMapToMarkers() {
    if (!mapInstance) return;
    if (currentMapBounds.length > 0) {
      mapInstance.fitBounds(currentMapBounds, { padding: [30, 30], maxZoom: 15 });
    }
  }

  // Leaflet caches the container size, so any time the map goes from hidden to
  // visible (or changes width) it has to be told to re-measure.
  function invalidateMapSize() {
    if (!mapInstance) return;
    mapInstance.invalidateSize();
    fitMapToMarkers();
  }

  /* Category glyphs for map pins. Emoji cost nothing to load and read at a
     glance; anything without a mapping falls back to the plain numbered pin. */
  const MAP_PIN_EMOJI = {
    visit: "🏛️",
    activity: "⛰️",
    eat: "☕",
    dish: "🍜",
    shopping: "🛍️",
    happening: "🎉"
  };

  // Order the legend reads in, matching the browse sections
  const MAP_LEGEND = [
    { key: "visit", label: "Landmarks" },
    { key: "activity", label: "Activities" },
    { key: "eat", label: "Cafés & Restaurants" },
    { key: "dish", label: "Dishes to Try" },
    { key: "shopping", label: "Shopping" },
    { key: "happening", label: "Events" }
  ];

  function mapPinMarkup(item, idx) {
    const emoji = MAP_PIN_EMOJI[item.category];
    const label = CATEGORY_LABEL[item.category] || "Place";
    if (!emoji) {
      // Fallback: the original numbered teardrop
      return `<div class="map-pin-badge" role="img" aria-label="${label} ${idx + 1}"><span>${idx + 1}</span></div>`;
    }
    return `<div class="map-pin-emoji" role="img" aria-label="${label}: ${item.name}"><span>${emoji}</span></div>`;
  }

  // Which days' pins are on the map. Absent from the set means visible, so a
  // fresh trip and any newly added day both default to showing.
  function dayPinsVisible(day) {
    return !state.hiddenMapDays.includes(day);
  }

  function toggleDayPins(day) {
    const at = state.hiddenMapDays.indexOf(day);
    if (at > -1) state.hiddenMapDays.splice(at, 1);
    else state.hiddenMapDays.push(day);
    renderMapView();
  }

  function renderMapView() {
    /* The map shows the whole trip, not just the open day, so the day
       checkboxes have something to filter. */
    const scopeItems = [];
    for (let day = 1; day <= state.tripDuration; day++) {
      if (!dayPinsVisible(day)) continue;
      (state.itinerary[day] || []).forEach(entry => {
        if (typeof entry.lat === "number" && typeof entry.lng === "number") {
          scopeItems.push({ entry, day });
        }
      });
    }

    // Nothing mappable yet and no map built — show a friendly placeholder instead of grey tiles
    if (!mapInstance && scopeItems.length === 0) {
      els.itineraryMap.innerHTML = `
        <div class="itinerary-map-empty">
          <span class="material-icons">location_off</span>
          <p>No mapped locations yet.<br>Add items to your plan to see pins here.</p>
        </div>
      `;
      return;
    }

    ensureMap();
    mapMarkersLayer.clearLayers();

    currentMapBounds = [];
    scopeItems.forEach(({ entry: item, day }, idx) => {
      // The anchor is the point that sits on the coordinate: the tip for the
      // teardrop fallback, the bottom-centre for the round emoji pin.
      const isEmoji = !!MAP_PIN_EMOJI[item.category];
      const size = isEmoji ? 32 : 26;
      const icon = L.divIcon({
        className: "",
        html: mapPinMarkup(item, idx),
        iconSize: [size, size],
        iconAnchor: [size / 2, size]
      });

      const marker = L.marker([item.lat, item.lng], {
        icon,
        title: item.name,
        alt: `${CATEGORY_LABEL[item.category] || "Place"}: ${item.name}`,
        riseOnHover: true,
        keyboard: true
      }).addTo(mapMarkersLayer);

      /* The day label is a permanent tooltip rather than more divIcon HTML.
         A tooltip stays bound to its marker — Leaflet moves, raises and removes
         it with the pin — whereas markup baked into the icon becomes an
         independent feature that has to be kept in sync by hand. */
      marker.bindTooltip(`Day ${day}`, {
        permanent: true,
        direction: "top",
        offset: [0, -size + 4],
        className: "map-day-tag",
        opacity: 1,
        interactive: false
      });

      marker.bindPopup(`
        <div class="map-popup-title">${item.name}</div>
        <div class="map-popup-meta">${formatMinutes(item.durationMinutes || 60)}${item.zone ? " · " + item.zone : ""}</div>
      `);
      currentMapBounds.push([item.lat, item.lng]);
    });

    // Let the container finish laying out before Leaflet measures it
    setTimeout(() => {
      mapInstance.invalidateSize();
      fitMapToMarkers();
    }, 50);
  }

  function saveItineraryDragOrder() {
    const currentRows = [...els.itineraryList.querySelectorAll(".itinerary-todo-row")];
    const newOrder = [];
    currentRows.forEach(row => {
      const itemId = row.dataset.itemId;
      const matchedItem = state.itinerary[state.activeDay].find(item => item.id === itemId);
      if (matchedItem) newOrder.push(matchedItem);
    });
    state.itinerary[state.activeDay] = newOrder;
    renderItinerary();
  }

  // 12c. Day / Week tabs
  function rebuildPlannerTabs() {
    els.dayNavigator.innerHTML = "";
    // Day-wise now uses the accordion, so the tab strip is week-only
    els.dayNavigator.style.display = state.planMode === "week" ? "flex" : "none";

    if (state.planMode === "week") {
      for (let w = 1; w <= totalWeeks(); w++) {
        const days = daysInWeek(w);
        const count = days.reduce((sum, d) => sum + (state.itinerary[d] || []).length, 0);
        const tab = document.createElement("button");
        tab.className = `day-tab ${state.activeWeek === w ? "active" : ""}`;
        tab.textContent = count > 0 ? `Week ${w} · ${count}` : `Week ${w}`;
        tab.addEventListener("click", () => {
          state.activeWeek = w;
          state.activeDay = daysInWeek(w)[0];
          rebuildPlannerTabs();
          renderItinerary();
          renderRecommendations();
        });
        els.dayNavigator.appendChild(tab);
      }
      return;
    }

    Object.keys(state.itinerary).forEach(day => {
      const dayNum = parseInt(day, 10);
      const tab = document.createElement("button");
      tab.className = `day-tab ${state.activeDay === dayNum ? "active" : ""}`;
      tab.textContent = `Day ${dayNum}`;
      tab.addEventListener("click", () => {
        state.activeDay = dayNum;
        state.activeWeek = weekOfDay(dayNum);
        rebuildPlannerTabs();
        renderItinerary();
        renderRecommendations();
      });
      els.dayNavigator.appendChild(tab);
    });
  }

  // 13. Search
  function handleSearch() {
    const query = els.searchInput.value.trim();
    if (query) {
      els.searchSuggestions.style.display = "none";
      loadCity(query);
    }
  }

  /* ---------- Full detail popup for an itinerary entry ---------- */

  function sourceItemFor(entry) {
    const match = ((state.currentCity && state.currentCity.items) || []).find(i => i.id === entry.id);
    return match || entry;
  }

  function openItemDetail(entry) {
    const item = sourceItemFor(entry);
    const edit = getCardEdit(item.id);
    const image = edit.image || item.image;
    const description = edit.description || item.description || "";

    els.detailPhoto.style.backgroundImage = image ? `url("${image}")` : "";
    els.detailPhoto.innerHTML = `<button class="modal-close-btn detail-close" id="close-detail-btn">&times;</button>`;
    if (!image) {
      els.detailPhoto.insertAdjacentHTML(
        "beforeend",
        `<div class="todo-photo-placeholder" style="height:100%;">${CATEGORY_EMOJI[item.category] || "📍"}</div>`
      );
    }
    els.detailPhoto.querySelector("#close-detail-btn").addEventListener("click", () => els.itemDetailModal.close());

    const chips = [];
    if (item.mustVisit) chips.push(`<span class="todo-badge must-visit-badge">Must Visit</span>`);
    else chips.push(`<span class="todo-badge">${CATEGORY_LABEL[item.category] || "Place"}</span>`);
    if (item.zone) chips.push(zoneChipMarkup(item.zone));
    if (item.location) chips.push(`<span class="meta-text">${item.location}</span>`);
    if (item.subcategory) chips.push(`<span class="meta-text">${item.subcategory}</span>`);
    chips.push(`<span class="todo-duration-chip" style="margin-left:0;"><span class="material-icons">schedule</span>${formatMinutes(parseDurationToMinutes(item))}</span>`);

    els.detailBody.innerHTML = `
      <div class="detail-chips">${chips.join("")}</div>
      <h3 class="detail-title">${item.name}</h3>
      ${description ? `<p class="detail-desc">${description}</p>` : ""}
      ${item.whyNow ? `<p class="happening-why">${item.whyNow}</p>` : ""}
      ${item.tip ? `<p class="todo-tip open">${item.tip}</p>` : ""}
      ${item.cost && item.cost !== "—" ? `<div><span class="detail-label">Cost</span><div class="detail-desc">${abbreviateAmounts(item.cost)}</div></div>` : ""}
      ${item.sourceUrl ? `<div><span class="detail-label">Source</span><div class="detail-desc">${sourceChipMarkup(item)}</div></div>` : ""}
      ${entry.link ? `<a class="itinerary-todo-link" href="${entry.link}" target="_blank" rel="noopener noreferrer"><span class="material-icons">open_in_new</span>Open in Google Maps</a>` : ""}
      <div class="detail-note">
        <span class="detail-label">Your note</span>
        <textarea placeholder="Jot a note for this…">${getNote(item.id)}</textarea>
      </div>
    `;

    const noteArea = els.detailBody.querySelector(".detail-note textarea");
    noteArea.addEventListener("input", () => {
      saveNote(item.id, noteArea.value);
      renderRecommendations();
    });

    els.itemDetailModal.showModal();
  }

  els.closeDetailBtn.addEventListener("click", () => els.itemDetailModal.close());

  /* ---------- Weather advisory (Open-Meteo, no API key needed) ---------- */

  function zoneCentroids() {
    const items = (state.currentCity && state.currentCity.items) || [];
    const byZone = {};
    items.forEach(i => {
      if (typeof i.lat !== "number" || !i.zone) return;
      if (!byZone[i.zone]) byZone[i.zone] = { lat: 0, lng: 0, n: 0 };
      byZone[i.zone].lat += i.lat;
      byZone[i.zone].lng += i.lng;
      byZone[i.zone].n++;
    });
    return Object.keys(byZone).map(zone => ({
      zone,
      lat: byZone[zone].lat / byZone[zone].n,
      lng: byZone[zone].lng / byZone[zone].n
    }));
  }

  // Local components, not toISOString — the UTC conversion shifts the date by a
  // day for anyone east of Greenwich, which silently misaligns the weather series.
  function isoDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  // Which days of the trip does each zone occupy, as real calendar dates?
  function zoneDateWindows() {
    if (!state.tripStartDate) return [];
    const start = new Date(`${state.tripStartDate}T00:00:00`);
    const windows = {};

    for (let day = 1; day <= state.tripDuration; day++) {
      (state.itinerary[day] || []).forEach(entry => {
        if (!entry.zone) return;
        if (!windows[entry.zone]) windows[entry.zone] = { first: day, last: day };
        windows[entry.zone].first = Math.min(windows[entry.zone].first, day);
        windows[entry.zone].last = Math.max(windows[entry.zone].last, day);
      });
    }

    return Object.keys(windows).map(zone => {
      const from = new Date(start);
      from.setDate(start.getDate() + windows[zone].first - 1);
      const to = new Date(start);
      to.setDate(start.getDate() + windows[zone].last - 1);
      return { zone, from, to };
    });
  }

  // One daily+hourly series per place, covering the whole trip span, for both
  // this year's dates and the same dates last year. Cached so a burst of
  // re-renders makes one round of requests.
  const weatherCache = new Map();

  function shiftYear(date, delta) {
    const d = new Date(date);
    d.setFullYear(date.getFullYear() + delta);
    return d;
  }

  async function fetchSeries(base, lat, lng, from, to, extraDaily) {
    const url = `${base}?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum${extraDaily}` +
      `&hourly=precipitation&timezone=auto` +
      `&start_date=${isoDate(from)}&end_date=${isoDate(to)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Weather lookup failed");
    return res.json();
  }

  // Turn a raw Open-Meteo payload into { "2026-11-04": {tmax, tmin, rain, prob, amRain, pmRain} }
  function indexByDate(payload) {
    const out = {};
    const daily = (payload && payload.daily) || {};
    (daily.time || []).forEach((date, i) => {
      out[date] = {
        tmax: daily.temperature_2m_max ? daily.temperature_2m_max[i] : null,
        tmin: daily.temperature_2m_min ? daily.temperature_2m_min[i] : null,
        rain: daily.precipitation_sum ? daily.precipitation_sum[i] : null,
        prob: daily.precipitation_probability_max ? daily.precipitation_probability_max[i] : null,
        amRain: 0,
        pmRain: 0
      };
    });

    // Split each day's rain into morning (06–12) and afternoon/evening (12–20)
    const hourly = (payload && payload.hourly) || {};
    (hourly.time || []).forEach((stamp, i) => {
      const date = stamp.slice(0, 10);
      const hour = parseInt(stamp.slice(11, 13), 10);
      const mm = hourly.precipitation ? hourly.precipitation[i] : 0;
      if (!out[date] || typeof mm !== "number") return;
      if (hour >= 6 && hour < 12) out[date].amRain += mm;
      else if (hour >= 12 && hour < 20) out[date].pmRain += mm;
    });

    return out;
  }

  // Everything the UI needs for one place across the trip: this year and last year
  async function placeWeather(lat, lng, from, to) {
    const key = `${lat.toFixed(2)},${lng.toFixed(2)}|${isoDate(from)}|${isoDate(to)}`;
    if (weatherCache.has(key)) return weatherCache.get(key);

    const promise = (async () => {
      const today = new Date();
      // Open-Meteo rejects an end_date beyond today+14, and a request that
      // overshoots it 400s outright rather than being clamped server-side.
      const horizon = new Date(today.getTime() + 14 * 86400000);
      const forecastable = to >= today && from <= horizon;

      let thisYear = {};
      let thisYearKind = "none";

      if (forecastable) {
        // The forecast API only reaches ~16 days out; clamp the window to that
        const fFrom = from < today ? today : from;
        const fTo = to > horizon ? horizon : to;
        try {
          const payload = await fetchSeries(
            "https://api.open-meteo.com/v1/forecast",
            lat, lng, fFrom, fTo, ",precipitation_probability_max"
          );
          thisYear = indexByDate(payload);
          thisYearKind = "forecast";
        } catch (e) { /* fall through to last year only */ }
      }

      // The archive, for the same dates in each of the last three years. Year -1
      // is shown as "last year"; all three average into the climate normal that
      // stands in for a forecast once the dates are too far out to forecast.
      const history = await Promise.all([1, 2, 3].map(async back => {
        try {
          const payload = await fetchSeries(
            "https://archive-api.open-meteo.com/v1/archive",
            lat, lng, shiftYear(from, -back), shiftYear(to, -back), ""
          );
          // Re-key onto this year's dates so every series lines up day for day
          const raw = indexByDate(payload);
          const shifted = {};
          Object.keys(raw).forEach(date => {
            shifted[isoDate(shiftYear(new Date(`${date}T00:00:00`), back))] = raw[date];
          });
          return shifted;
        } catch (e) {
          return {};
        }
      }));

      const lastYear = history[0];

      const normals = {};
      const allDates = new Set(history.flatMap(h => Object.keys(h)));
      allDates.forEach(date => {
        const years = history.map(h => h[date]).filter(Boolean);
        if (!years.length) return;
        const mean = (fn) => {
          const vals = years.map(fn).filter(v => typeof v === "number");
          return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        };
        normals[date] = {
          tmax: mean(r => r.tmax),
          tmin: mean(r => r.tmin),
          rain: mean(r => r.rain),
          prob: null,
          amRain: mean(r => r.amRain) || 0,
          pmRain: mean(r => r.pmRain) || 0,
          years: years.length
        };
      });

      // The forecast only reaches ~16 days in; normals cover the rest of the trip,
      // so tag each date with where its numbers came from and let forecast win.
      Object.values(thisYear).forEach(r => { r.kind = "forecast"; });
      Object.values(normals).forEach(r => { r.kind = "normal"; });
      thisYear = { ...normals, ...thisYear };
      thisYearKind = Object.keys(thisYear).length
        ? (thisYearKind === "forecast" ? "forecast" : "normal")
        : "none";

      return { thisYear, thisYearKind, lastYear, normals };
    })();

    weatherCache.set(key, promise);
    return promise;
  }

  /* ---------- Reading a single day ---------- */

  // What we know about one place on one date: the forecast if we have it,
  // otherwise last year's actuals on the same date as a typical-conditions proxy.
  function readDay(series, date) {
    if (!series) return null;
    const live = series.thisYear[date];
    if (live && typeof live.rain === "number") return { ...live, kind: live.kind || "normal" };
    const past = series.lastYear[date];
    if (past && typeof past.rain === "number") return { ...past, kind: "typical" };
    return null;
  }

  function gradeDay(reading) {
    if (!reading) return { level: "good", label: "" };
    const rain = reading.rain || 0;
    const prob = typeof reading.prob === "number" ? reading.prob : null;
    const hot = typeof reading.tmax === "number" && reading.tmax >= 35;

    if (rain >= 20 || (prob !== null && prob >= 80)) {
      return { level: "warn", label: rain >= 20 ? `${Math.round(rain)}mm of rain` : `${prob}% chance of rain` };
    }
    if (rain >= 7 || (prob !== null && prob >= 55)) {
      return { level: "info", label: rain >= 7 ? `${Math.round(rain)}mm of rain` : `${prob}% chance of rain` };
    }
    if (hot) return { level: "info", label: `${Math.round(reading.tmax)}°C peak` };
    return { level: "good", label: "" };
  }

  /* ---------- Per-item nudges ---------- */

  // Cached per render pass: { "itemId|day": {level, reading, advice…} }
  let itemNudges = {};

  function tripDateFor(day) {
    if (!state.tripStartDate) return null;
    const start = new Date(`${state.tripStartDate}T00:00:00`);
    if (Number.isNaN(start.getTime())) return null;
    const d = new Date(start);
    d.setDate(start.getDate() + day - 1);
    return d;
  }

  // Weather is always fetched for a fixed window from the start date rather than
  // the exact trip length, so lengthening or shortening the trip reuses the
  // cached series instead of refetching every place from scratch.
  function weatherSpan() {
    const from = tripDateFor(1);
    if (!from) return null;
    const to = new Date(from);
    to.setDate(from.getDate() + MAX_TRIP_DAYS - 1);
    return { from, to };
  }

  // Indoor things are barely affected by rain; outdoor ones are the point of this
  function weatherSensitivity(item) {
    if (item.category === "dish" || item.category === "eat") return "low";
    const sub = (item.subcategory || "").toLowerCase();
    if (sub.includes("museum") || sub.includes("historical") || sub.includes("cultural")) return "medium";
    if (item.category === "shopping") return "medium";
    return "high";
  }

  // Every place the itinerary touches, deduped to one weather request each
  function scheduledPlaces() {
    const places = new Map();
    for (let day = 1; day <= state.tripDuration; day++) {
      (state.itinerary[day] || []).forEach(entry => {
        const src = sourceItemFor(entry);
        if (typeof src.lat !== "number" || typeof src.lng !== "number") return;
        const key = src.location || src.zone || `${src.lat.toFixed(2)},${src.lng.toFixed(2)}`;
        if (!places.has(key)) places.set(key, { key, lat: src.lat, lng: src.lng, label: key, zone: src.zone });
      });
    }
    return [...places.values()];
  }

  function placeKeyFor(entry) {
    const src = sourceItemFor(entry);
    if (typeof src.lat !== "number") return null;
    return src.location || src.zone || `${src.lat.toFixed(2)},${src.lng.toFixed(2)}`;
  }

  // Build the advice for one scheduled item on one day
  function buildNudge(entry, day, series) {
    const date = tripDateFor(day);
    if (!date) return null;
    const reading = readDay(series, isoDate(date));
    if (!reading) return null;

    const grade = gradeDay(reading);
    const sensitivity = weatherSensitivity(entry);
    if (grade.level === "good") return null;
    // A drizzle doesn't need a warning on a dinner reservation
    if (sensitivity === "low" && grade.level !== "warn") return null;

    const advice = [];
    let headline;

    const am = reading.amRain || 0;
    const pm = reading.pmRain || 0;
    const total = am + pm;

    // "Move up or down": does the rain sit in one half of the day?
    let shift = null;
    if (total >= 4 && pm / Math.max(am, 0.1) >= 2) {
      shift = "earlier";
    } else if (total >= 4 && am / Math.max(pm, 0.1) >= 2) {
      shift = "later";
    }

    // "Plan it on a different day": is there a drier day at the same place?
    let betterDay = null;
    let betterRain = reading.rain || 0;
    for (let d = 1; d <= state.tripDuration; d++) {
      if (d === day) continue;
      const other = tripDateFor(d);
      if (!other) continue;
      const r = readDay(series, isoDate(other));
      if (!r || typeof r.rain !== "number") continue;
      if (r.rain < betterRain - 5) {
        betterRain = r.rain;
        betterDay = d;
      }
    }

    if (grade.level === "warn") {
      headline = `A wet day for ${entry.name}`;
      advice.push(`${dayDateLabel(day)} looks properly wet here — ${grade.label}${
        typeof reading.tmax === "number" ? `, around ${Math.round(reading.tmax)}°C` : ""}.`);
    } else {
      headline = `Keep an eye on the sky`;
      advice.push(`${dayDateLabel(day)} looks unsettled here — ${grade.label}${
        typeof reading.tmax === "number" ? `, around ${Math.round(reading.tmax)}°C` : ""}.`);
    }

    const actions = [];
    if (shift === "earlier") {
      actions.push({
        icon: "arrow_upward",
        text: `Move this up — the rain concentrates in the afternoon (${am.toFixed(1)}mm before noon vs ${pm.toFixed(1)}mm after). A morning slot should stay dry.`
      });
    } else if (shift === "later") {
      actions.push({
        icon: "arrow_downward",
        text: `Move this down — the wet hours are in the morning (${am.toFixed(1)}mm before noon vs ${pm.toFixed(1)}mm after). Push it to the afternoon.`
      });
    }

    if (betterDay) {
      actions.push({
        icon: "event_repeat",
        text: `Day ${betterDay} (${dayDateLabel(betterDay)}) looks drier at the same place — about ${Math.round(betterRain)}mm. Worth swapping if this one is weather-dependent.`
      });
    }

    if (!actions.length) {
      actions.push({
        icon: grade.level === "warn" ? "umbrella" : "info",
        text: grade.level === "warn"
          ? "Every day here looks similar, so there's no better slot to move to — go anyway, but pack a poncho and treat outdoor time as optional."
          : "Nothing worth rescheduling for. Just carry a light rain layer."
      });
    }

    // "How bad can it be" — put a number on it
    const severity = grade.level === "warn"
      ? (reading.rain >= 50 ? "Heavy — the kind of rain that ends outdoor plans." : "Moderate to heavy — expect a few soaked hours, not a washout.")
      : "Light — passing showers rather than a day indoors.";

    return {
      level: grade.level,
      headline,
      lines: advice,
      actions,
      severity,
      kind: reading.kind,
      sensitivity
    };
  }

  // Fill itemNudges for the current itinerary, then repaint the chips in place
  async function refreshItemNudges() {
    const span = weatherSpan();
    if (!span || !state.currentCity) {
      itemNudges = {};
      paintNudgeChips();
      return;
    }

    const places = scheduledPlaces();
    if (!places.length) {
      itemNudges = {};
      paintNudgeChips();
      return;
    }

    const seriesByPlace = {};
    await Promise.all(places.map(async p => {
      try {
        seriesByPlace[p.key] = await placeWeather(p.lat, p.lng, span.from, span.to);
      } catch (e) { /* skip this place */ }
    }));

    // Build into a fresh map and swap at the end, so a re-render mid-fetch
    // doesn't blank the chips that are already on screen.
    const next = {};
    for (let day = 1; day <= state.tripDuration; day++) {
      (state.itinerary[day] || []).forEach(entry => {
        const key = placeKeyFor(entry);
        if (!key || !seriesByPlace[key]) return;
        const nudge = buildNudge(entry, day, seriesByPlace[key]);
        if (nudge) next[`${entry.id}|${day}`] = nudge;
      });
    }

    itemNudges = next;
    paintNudgeChips();
  }

  // Nudges arrive after the itinerary is already on screen, so inject them
  // into the existing rows rather than forcing a full re-render.
  function paintNudgeChips() {
    document.querySelectorAll("[data-nudge-slot]").forEach(slot => {
      const nudge = itemNudges[slot.dataset.nudgeSlot];
      if (!nudge) {
        slot.innerHTML = "";
        return;
      }
      slot.innerHTML = `
        <button class="weather-nudge-chip" data-level="${nudge.level}" title="Weather note for this day">
          <span class="material-icons">${nudge.level === "warn" ? "grain" : "cloud"}</span>
        </button>
      `;
      slot.querySelector(".weather-nudge-chip").addEventListener("click", (e) => {
        e.stopPropagation();
        openWeatherNudge(slot.dataset.nudgeSlot);
      });
    });

    // A collapsed day still says whether anything on it is weather-affected
    document.querySelectorAll("[data-nudge-day]").forEach(slot => {
      const day = parseInt(slot.dataset.nudgeDay, 10);
      const levels = Object.keys(itemNudges)
        .filter(k => parseInt(k.split("|")[1], 10) === day)
        .map(k => itemNudges[k].level);

      if (!levels.length) {
        slot.innerHTML = "";
        return;
      }

      const level = levels.includes("warn") ? "warn" : "info";
      const label = levels.length === 1
        ? "1 item on this day is weather-affected"
        : `${levels.length} items on this day are weather-affected`;
      slot.innerHTML = `
        <span class="weather-nudge-chip day-nudge" data-level="${level}" title="${label} — expand the day for details">
          <span class="material-icons">${level === "warn" ? "grain" : "cloud"}</span>
        </span>
      `;
    });
  }

  function nudgeSlotMarkup(entry, day) {
    return `<span class="nudge-slot" data-nudge-slot="${entry.id}|${day}"></span>`;
  }

  function openWeatherNudge(slotKey) {
    const nudge = itemNudges[slotKey];
    if (!nudge) return;

    els.weatherNudgeTitle.textContent = nudge.headline;
    els.weatherNudgeBody.innerHTML = `
      <div class="nudge-severity" data-level="${nudge.level}">
        <span class="material-icons">${nudge.level === "warn" ? "grain" : "cloud"}</span>
        <div>
          <strong>${nudge.severity}</strong>
          ${nudge.lines.map(l => `<p>${l}</p>`).join("")}
        </div>
      </div>
      <div class="nudge-actions">
        ${nudge.actions.map(a => `
          <div class="nudge-action">
            <span class="material-icons">${a.icon}</span>
            <span>${a.text}</span>
          </div>
        `).join("")}
      </div>
      <div class="weather-source">${nudge.kind === "forecast"
        ? "Based on the live forecast for this date."
        : "Beyond the forecast window, so this is the three-year average for this calendar date — typical, not certain."}</div>
    `;
    els.weatherNudgeModal.showModal();
  }

  /* ---------- The collapsed chip and its full outlook ---------- */

  let outlookRows = [];

  function summarise(series, dates) {
    const pick = (source) => {
      const days = dates.map(d => source[d]).filter(r => r && typeof r.rain === "number");
      if (!days.length) return null;
      const rain = days.reduce((a, r) => a + (r.rain || 0), 0);
      const temps = days.map(r => r.tmax).filter(v => typeof v === "number");
      return {
        days: days.length,
        rain: Math.round(rain),
        wetDays: days.filter(r => (r.rain || 0) >= 10).length,
        tmax: temps.length ? Math.round(Math.max(...temps)) : null,
        tavg: temps.length ? Math.round(temps.reduce((a, b) => a + b, 0) / temps.length) : null
      };
    };
    return { thisYear: pick(series.thisYear), lastYear: pick(series.lastYear) };
  }

  async function renderWeatherOutlook() {
    if (!state.tripStartDate || !state.currentCity) {
      els.weatherChipRow.style.display = "none";
      syncActionsRow();
      return;
    }

    const span = weatherSpan();
    const centroids = zoneCentroids();
    const windows = zoneDateWindows().filter(w => centroids.some(c => c.zone === w.zone));
    if (!span || !windows.length) {
      els.weatherChipRow.style.display = "none";
      syncActionsRow();
      return;
    }

    els.weatherChipRow.style.display = "flex";
    syncActionsRow();
    els.weatherChip.classList.add("loading");

    // Prefer a place the itinerary already visits in this zone — its series is
    // usually cached from the nudge pass, so the outlook costs no extra requests.
    const visited = scheduledPlaces();

    const rows = [];
    for (const w of windows) {
      const centroid = visited.find(p => p.zone === w.zone) || centroids.find(c => c.zone === w.zone);
      const dates = [];
      for (let d = new Date(w.from); d <= w.to; d.setDate(d.getDate() + 1)) dates.push(isoDate(d));
      try {
        const series = await placeWeather(centroid.lat, centroid.lng, span.from, span.to);
        const stats = summarise(series, dates);
        const worst = dates
          .map(date => gradeDay(readDay(series, date)).level)
          .reduce((a, b) => (a === "warn" || b === "warn" ? "warn" : a === "info" || b === "info" ? "info" : "good"), "good");
        rows.push({ zone: w.zone, from: w.from, to: w.to, stats, level: worst, kind: series.thisYearKind });
      } catch (e) {
        rows.push({ zone: w.zone, from: w.from, to: w.to, stats: null, level: "info" });
      }
    }

    outlookRows = rows;
    els.weatherChip.classList.remove("loading");

    const worst = rows.some(r => r.level === "warn") ? "warn"
      : rows.some(r => r.level === "info") ? "info" : "good";
    els.weatherChipDot.dataset.level = worst;
    els.weatherChipIcon.textContent = worst === "warn" ? "grain" : worst === "info" ? "cloud" : "wb_sunny";
    els.weatherChip.title = worst === "warn"
      ? "Rain expected on some of your dates — tap for the outlook"
      : worst === "info"
        ? "Some unsettled days ahead — tap for the outlook"
        : "Conditions look good — tap for the outlook";

    // Nudges depend on the same data, so warm them up alongside
    refreshItemNudges();
  }

  function fmtRange(from, to) {
    const opts = { day: "numeric", month: "short" };
    const a = from.toLocaleDateString(undefined, opts);
    const b = to.toLocaleDateString(undefined, opts);
    return a === b ? a : `${a} – ${b}`;
  }

  function statCell(stats, label) {
    if (!stats) return `<div class="wx-cell"><span class="wx-cell-label">${label}</span><span class="wx-cell-empty">no data</span></div>`;
    return `
      <div class="wx-cell">
        <span class="wx-cell-label">${label}</span>
        <span class="wx-cell-main">${stats.tavg !== null ? `${stats.tavg}°C` : "—"}</span>
        <span class="wx-cell-sub">${stats.rain}mm over ${stats.days} day${stats.days === 1 ? "" : "s"}</span>
        <span class="wx-cell-sub">${stats.wetDays
          ? `${stats.wetDays} wet day${stats.wetDays === 1 ? "" : "s"}`
          : "no washouts"}</span>
      </div>
    `;
  }

  function openWeatherModal() {
    if (!outlookRows.length) {
      els.weatherModalBody.innerHTML = `<div class="weather-empty">Set your trip dates and add a few places to see the outlook.</div>`;
      els.weatherModal.showModal();
      return;
    }

    const verdict = (row) => {
      const t = row.stats && row.stats.thisYear;
      if (!t) return "Couldn't be checked right now.";
      if (row.level === "warn") {
        return t.wetDays
          ? `Plan indoor fallbacks — ${t.wetDays} of ${t.days} day${t.days === 1 ? "" : "s"} here look properly wet.`
          : "Plan indoor fallbacks — heavy rain likely across these dates.";
      }
      if (row.level === "info") return "Passing showers likely, nothing that should reshape the plan.";
      return "Comfortable window — no weather reason to move anything.";
    };

    const drift = (row) => {
      const a = row.stats && row.stats.thisYear;
      const b = row.stats && row.stats.lastYear;
      if (!a || !b) return "";
      const diff = a.rain - b.rain;
      if (Math.abs(diff) < 10) return "Tracking close to last year on the same dates.";
      return diff > 0
        ? `About ${Math.round(diff)}mm wetter than the same dates last year.`
        : `About ${Math.round(-diff)}mm drier than the same dates last year.`;
    };

    els.weatherModalBody.innerHTML = `
      <p class="weather-modal-intro">
        Your dates, region by region — this year's outlook next to what actually
        happened on the same dates last year.
      </p>
      ${outlookRows.map(row => `
        <div class="wx-row" data-level="${row.level}">
          <div class="wx-row-head">
            <span class="material-icons">${row.level === "warn" ? "grain" : row.level === "info" ? "cloud" : "wb_sunny"}</span>
            <div>
              <strong>${row.zone}</strong>
              <span class="wx-row-dates">${fmtRange(row.from, row.to)}</span>
            </div>
          </div>
          <div class="wx-grid">
            ${statCell(
              row.stats && row.stats.thisYear,
              row.kind === "forecast" ? "This year · forecast" : "This year · typical"
            )}
            ${statCell(row.stats && row.stats.lastYear, "Last year · actual")}
          </div>
          <div class="wx-verdict">${verdict(row)}</div>
          ${drift(row) ? `<div class="wx-drift">${drift(row)}</div>` : ""}
        </div>
      `).join("")}
      <div class="weather-source">
        Live forecasts reach about two weeks out. Past that, "this year" is the
        three-year average for the same calendar dates — typical, not a prediction.
        The second column is what actually happened on those dates last year.
      </div>
    `;
    els.weatherModal.showModal();
  }

  els.weatherChip.addEventListener("click", openWeatherModal);
  els.closeWeatherModalBtn.addEventListener("click", () => els.weatherModal.close());
  els.closeWeatherNudgeBtn.addEventListener("click", () => els.weatherNudgeModal.close());

  /* ==========================================
     Event Listeners
     ========================================== */

  els.apiStatusBadge.addEventListener("click", () => {
    els.geminiApiKeyInput.value = state.apiKey;
    els.settingsModal.showModal();
  });

  els.closeSettingsBtn.addEventListener("click", () => els.settingsModal.close());

  els.saveKeyBtn.addEventListener("click", () => {
    state.apiKey = els.geminiApiKeyInput.value.trim();
    localStorage.setItem("detour_gemini_key", state.apiKey);
    updateApiBadge();
    els.settingsModal.close();
  });

  els.clearKeyBtn.addEventListener("click", () => {
    state.apiKey = "";
    localStorage.removeItem("detour_gemini_key");
    els.geminiApiKeyInput.value = "";
    updateApiBadge();
    els.settingsModal.close();
  });

  // Primary anchor chips
  els.categoryFilterBar.addEventListener("click", (e) => {
    const btn = e.target.closest(".anchor-chip");
    if (!btn) return;

    document.querySelectorAll(".anchor-chip").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.currentCategory = btn.dataset.category;
    renderRecommendations();
  });

  // Secondary toggle chips
  els.filterSocialsBtn.addEventListener("click", () => {
    state.filterSocials = !state.filterSocials;
    els.filterSocialsBtn.classList.toggle("active", state.filterSocials);
    renderRecommendations();
  });

  els.filterBookmarksBtn.addEventListener("click", () => {
    state.filterBookmarked = !state.filterBookmarked;
    els.filterBookmarksBtn.classList.toggle("active", state.filterBookmarked);
    renderRecommendations();
  });

  // Hero cover photo
  els.coverEditBtn.addEventListener("click", openCoverModal);

  els.searchInput.addEventListener("input", (e) => {
    const val = e.target.value.toLowerCase().trim();
    if (val.length < 1) {
      els.searchSuggestions.style.display = "none";
      return;
    }

    const matches = Object.keys(mockDestinations).filter(key => key.includes(val));
    if (matches.length > 0) {
      els.searchSuggestions.innerHTML = "";
      matches.forEach(m => {
        const li = document.createElement("li");
        li.textContent = mockDestinations[m].name;
        li.addEventListener("click", () => {
          els.searchInput.value = mockDestinations[m].name;
          els.searchSuggestions.style.display = "none";
          loadCity(m);
        });
        els.searchSuggestions.appendChild(li);
      });
      els.searchSuggestions.style.display = "block";
    } else {
      els.searchSuggestions.style.display = "none";
    }
  });

  document.addEventListener("click", (e) => {
    if (!els.searchSuggestions.contains(e.target) && e.target !== els.searchInput) {
      els.searchSuggestions.style.display = "none";
    }
  });

  els.searchInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") handleSearch();
  });

  els.searchBtn.addEventListener("click", handleSearch);

  // Planner: collapse / expand
  function setPlannerCollapsed(collapsed) {
    state.plannerCollapsed = collapsed;
    els.plannerSidebar.style.display = collapsed ? "none" : "flex";
    els.plannerRail.style.display = collapsed ? "flex" : "none";
    if (!collapsed) setTimeout(invalidateMapSize, 60);
  }

  els.plannerCollapseBtn.addEventListener("click", () => setPlannerCollapsed(true));
  els.plannerRail.addEventListener("click", () => setPlannerCollapsed(false));

  // Drag the planner's left edge to give the itinerary more room
  const MIN_PLANNER_WIDTH = 300;
  const MAX_PLANNER_WIDTH = 760;

  function applyPlannerWidth(width) {
    const clamped = Math.min(MAX_PLANNER_WIDTH, Math.max(MIN_PLANNER_WIDTH, Math.round(width)));
    state.plannerWidth = clamped;
    els.plannerSidebar.style.flexBasis = `${clamped}px`;
    return clamped;
  }

  els.plannerResizeHandle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    els.plannerResizeHandle.classList.add("dragging");
    document.body.classList.add("resizing-planner");

    const onMove = (moveEvent) => {
      // The panel is anchored to the right edge, so width grows as the pointer moves left
      applyPlannerWidth(window.innerWidth - moveEvent.clientX);
      updateItineraryColumns();
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      els.plannerResizeHandle.classList.remove("dragging");
      document.body.classList.remove("resizing-planner");
      localStorage.setItem("detour_planner_width", String(state.plannerWidth));
      if (mapInstance) mapInstance.invalidateSize();
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  /* ---------- Plan view: drag the divider between itinerary and map ---------- */

  const MIN_MAP_WIDTH = 280;
  const MAX_MAP_WIDTH = 900;
  const DEFAULT_MAP_WIDTH = 420;

  function applyMapWidth(width) {
    const available = els.planSplit ? els.planSplit.clientWidth : window.innerWidth;
    // Always leave room for the itinerary column beside it
    const upper = Math.min(MAX_MAP_WIDTH, Math.max(MIN_MAP_WIDTH, available - 360));
    const clamped = Math.min(upper, Math.max(MIN_MAP_WIDTH, Math.round(width)));
    state.mapWidth = clamped;
    els.appContainer.style.setProperty("--plan-map-width", `${clamped}px`);
    return clamped;
  }

  if (els.planSplitHandle) {
    els.planSplitHandle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      els.planSplitHandle.classList.add("dragging");
      document.body.classList.add("resizing-split");

      const onMove = (moveEvent) => {
        // The map column is on the right, so its width grows as the pointer moves left
        const rect = els.planSplit.getBoundingClientRect();
        applyMapWidth(rect.right - moveEvent.clientX);
        updateItineraryColumns();
        if (mapInstance) mapInstance.invalidateSize();
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        els.planSplitHandle.classList.remove("dragging");
        document.body.classList.remove("resizing-split");
        localStorage.setItem("detour_map_width", String(state.mapWidth));
        invalidateMapSize();
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    // Double-click the divider to snap the map back to its default width
    els.planSplitHandle.addEventListener("dblclick", () => {
      applyMapWidth(DEFAULT_MAP_WIDTH);
      updateItineraryColumns();
      localStorage.setItem("detour_map_width", String(state.mapWidth));
      invalidateMapSize();
    });
  }

  // Double-click the handle to snap back to the default width
  els.plannerResizeHandle.addEventListener("dblclick", () => {
    applyPlannerWidth(340);
    updateItineraryColumns();
    localStorage.setItem("detour_planner_width", String(state.plannerWidth));
    if (mapInstance) mapInstance.invalidateSize();
  });

  /* ---------- Week sections ---------- */

  function sectionsForWeek(week) {
    if (!state.weekSections[week]) state.weekSections[week] = [];
    return state.weekSections[week];
  }

  els.addSectionBtn.addEventListener("click", () => {
    const name = prompt("Name this section (e.g. “Hanoi & the north”, “Beach days”)");
    if (!name || !name.trim()) return;

    sectionsForWeek(state.activeWeek).push({
      id: `sec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: name.trim()
    });
    renderItinerary();
  });

  function renameSection(week, sectionId) {
    const section = sectionsForWeek(week).find(s => s.id === sectionId);
    if (!section) return;
    const name = prompt("Rename section", section.name);
    if (!name || !name.trim()) return;
    section.name = name.trim();
    renderItinerary();
  }

  function deleteSection(week, sectionId) {
    state.weekSections[week] = sectionsForWeek(week).filter(s => s.id !== sectionId);
    // Items in the removed section fall back to the unsectioned group
    daysInWeek(week).forEach(day => {
      (state.itinerary[day] || []).forEach(entry => {
        if (entry.sectionId === sectionId) delete entry.sectionId;
      });
    });
    renderItinerary();
  }

  // Trip duration
  els.tripDurationSelect.addEventListener("change", (e) => requestTripDuration(e.target.value));
  els.durationMinus.addEventListener("click", () => requestTripDuration(state.tripDuration - 1));
  els.durationPlus.addEventListener("click", () => requestTripDuration(state.tripDuration + 1));

  function dismissDurationConfirm() {
    state.pendingDuration = null;
    els.tripDurationSelect.value = state.tripDuration; // undo the typed value
    els.durationConfirmModal.close();
  }

  els.closeDurationConfirmBtn.addEventListener("click", dismissDurationConfirm);
  els.durationConfirmModal.addEventListener("cancel", (e) => {
    e.preventDefault();
    dismissDurationConfirm();
  });

  els.durationRebuildBtn.addEventListener("click", () => {
    const days = state.pendingDuration;
    state.pendingDuration = null;
    els.durationConfirmModal.close();
    if (days) applyTripDuration(days, true);
  });

  els.durationKeepBtn.addEventListener("click", () => {
    const days = state.pendingDuration;
    state.pendingDuration = null;
    els.durationConfirmModal.close();
    if (days) applyTripDuration(days, false);
  });

  // Day-wise vs Week-wise
  els.planModeToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".segmented-btn");
    if (!btn || btn.dataset.mode === state.planMode) return;

    state.planMode = btn.dataset.mode;
    els.planModeToggle.querySelectorAll(".segmented-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.mode === state.planMode);
    });

    if (state.planMode === "week") {
      state.activeWeek = weekOfDay(state.activeDay);
    } else {
      state.activeDay = daysInWeek(state.activeWeek)[0];
    }

    rebuildPlannerTabs();
    renderItinerary();
    renderRecommendations();
  });

  els.clearItineraryBtn.addEventListener("click", () => {
    if (confirm("Reset current itinerary? All days will be cleared.")) {
      for (let d = 1; d <= state.tripDuration; d++) {
        state.itinerary[d] = [];
      }
      renderItinerary();
      renderRecommendations();
    }
  });

  /* ---------- Expanded map ---------- */

  // The live map element is moved into the dialog and back, so there's only ever one map
  els.mapExpandBtn.addEventListener("click", () => {
    els.mapModalTitle.textContent = `${state.currentCity ? state.currentCity.name : "Trip"} · ${scopeLabel()}`;
    els.mapModalBody.appendChild(els.itineraryMap);
    els.mapExpandModal.showModal();
    setTimeout(() => {
      if (mapInstance) {
        mapInstance.invalidateSize();
        fitMapToMarkers();
      }
    }, 80);
  });

  function collapseMap() {
    els.plannerMapSection.insertBefore(els.itineraryMap, els.mapExpandBtn);
    els.mapExpandModal.close();
    setTimeout(() => {
      if (mapInstance) {
        mapInstance.invalidateSize();
        fitMapToMarkers();
      }
    }, 80);
  }

  els.closeMapModalBtn.addEventListener("click", collapseMap);
  els.mapExpandModal.addEventListener("cancel", (e) => {
    e.preventDefault();
    collapseMap();
  });

  /* ---------- Travel dates & live happenings ---------- */

  function formatDateLabel(date) {
    return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  function tripEndDate() {
    if (!state.tripStartDate) return null;
    const start = new Date(`${state.tripStartDate}T00:00:00`);
    if (Number.isNaN(start.getTime())) return null;
    const end = new Date(start);
    end.setDate(start.getDate() + state.tripDuration - 1);
    return end;
  }

  /* The row always shows now that Reset and Export live in it; only the two
     date-dependent CTAs come and go, and the divider goes with them. */
  function syncActionsRow() {
    const dateCtasVisible = els.happeningsRow.style.display !== "none"
      || els.weatherChipRow.style.display !== "none";
    const divider = els.plannerActionsRow.querySelector(".actions-divider");
    if (divider) divider.style.display = dateCtasVisible ? "block" : "none";
  }

  function renderTripDates() {
    els.tripStartDate.value = state.tripStartDate || "";
    const end = tripEndDate();

    if (end) {
      const start = new Date(`${state.tripStartDate}T00:00:00`);
      els.tripEndDate.textContent = `${formatDateLabel(start)} → ${formatDateLabel(end)}`;
      els.happeningsRow.style.display = "flex";
    } else {
      els.tripEndDate.textContent = "Add a start date";
      els.happeningsRow.style.display = "none";
    }

    syncActionsRow();
    renderWeatherOutlook();
  }

  els.tripStartDate.addEventListener("change", (e) => {
    state.tripStartDate = e.target.value || "";
    if (state.tripStartDate) {
      localStorage.setItem("detour_trip_start", state.tripStartDate);
    } else {
      localStorage.removeItem("detour_trip_start");
    }
    renderTripDates();
    renderItinerary(); // day rows now show real calendar dates
  });

  // Ask Gemini (with search grounding) what's actually on while you're there
  async function fetchHappenings(cityName, startDate, endDate) {
    const promptText = `
      Search the web for what is genuinely happening in ${cityName} between ${startDate} and ${endDate}.

      Include a mix of:
      - Festivals, public holidays and cultural events falling in that window
      - Seasonal natural phenomena unique to that time of year (a flower blooming, rice terraces
        turning gold, a migration, a harvest, monsoon or dry-season effects)
      - Notable one-off events, exhibitions or markets scheduled in that window

      Only include things that genuinely occur in that date range — do not invent events, and do not
      list generic year-round attractions. If you are unsure an event runs in that window, leave it out.

      Return ONLY a raw JSON array (no markdown fences), up to 10 items, each shaped exactly like:
      {
        "name": "Specific name of the event or seasonal phenomenon",
        "kind": "festival",
        "dateLabel": "Short human date, e.g. '15–17 Sep' or 'Late September'",
        "location": "City or area where it happens",
        "zone": "Wider region if relevant, else an empty string",
        "description": "1-2 sentences on what it actually is.",
        "whyNow": "One short sentence on why this is specific to these dates.",
        "duration": "Rough time to allow, e.g. '2h', 'Half Day'"
      }

      "kind" must be one of: "festival", "season", "event".
      If nothing notable falls in that window, return [].
    `;

    const text = await callGemini(promptText, { tools: [{ type: "google_search" }] });
    const parsed = parseJsonFromText(text, true);
    return Array.isArray(parsed) ? parsed : [];
  }

  els.findHappeningsBtn.addEventListener("click", async () => {
    if (!state.currentCity || !state.tripStartDate) return;

    if (!state.apiKey) {
      els.geminiApiKeyInput.value = state.apiKey;
      els.settingsModal.showModal();
      return;
    }

    const end = tripEndDate();
    const startLabel = formatDateLabel(new Date(`${state.tripStartDate}T00:00:00`));
    const endLabel = formatDateLabel(end);

    els.findHappeningsBtn.disabled = true;
    els.findHappeningsLabel.textContent = "Checking what's on…";

    try {
      const results = await fetchHappenings(state.currentCity.name, startLabel, endLabel);

      // Replace any previous suggestions so repeated searches don't pile up
      state.currentCity.items = state.currentCity.items.filter(i => i.category !== "happening");

      results.forEach(r => {
        if (!r || !r.name) return;
        state.currentCity.items.push({
          id: `happening-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          name: r.name,
          category: "happening",
          kind: r.kind || "event",
          dateLabel: r.dateLabel || "",
          whyNow: r.whyNow || "",
          zone: r.zone || "",
          location: r.location || "",
          description: r.description || "",
          duration: r.duration || "2h",
          cost: "—",
          tip: "",
          isHappening: true
        });
      });

      els.findHappeningsLabel.textContent = results.length
        ? `Found ${results.length} — see Seasonal & Events`
        : "Nothing notable found for those dates";

      state.currentCategory = "happening";
      document.querySelectorAll(".anchor-chip").forEach(b => {
        b.classList.toggle("active", b.dataset.category === "happening");
      });

      renderHero();
      renderFilterBars();
      renderRecommendations();
    } catch (err) {
      alert(err.message || "Couldn't look up events for those dates.");
      els.findHappeningsLabel.textContent = "Find what's on those dates";
    } finally {
      els.findHappeningsBtn.disabled = false;
      setTimeout(() => {
        els.findHappeningsLabel.textContent = "Find what's on those dates";
      }, 6000);
    }
  });

  // Add a custom location pin (paste a Google Maps link or type a place name)
  async function submitCustomLocation() {
    const raw = els.customLocationInput.value.trim();
    if (!raw) return;

    els.customLocationAddBtn.disabled = true;
    try {
      await handleAddCustomLocation(raw);
      els.customLocationInput.value = "";
      els.mapAddLocation.style.display = "none";
      els.mapAddPinBtn.classList.remove("active");
    } catch (err) {
      alert(err.message || "Couldn't add that location. Try a more specific name or a full Google Maps link.");
    } finally {
      els.customLocationAddBtn.disabled = false;
    }
  }

  // The link field lives behind the pin button on the map rather than always taking up space
  els.mapAddPinBtn.addEventListener("click", () => {
    const open = els.mapAddLocation.style.display === "flex";
    els.mapAddLocation.style.display = open ? "none" : "flex";
    els.mapAddPinBtn.classList.toggle("active", !open);
    if (!open) els.customLocationInput.focus();
  });

  els.customLocationAddBtn.addEventListener("click", submitCustomLocation);
  els.customLocationInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") submitCustomLocation();
  });

  /* ---------- Edit-card / cover modal ---------- */

  els.closeEditModalBtn.addEventListener("click", () => els.editCardModal.close());

  els.editImageUrlInput.addEventListener("input", () => {
    pendingEditImage = els.editImageUrlInput.value.trim();
    updateEditPreview(pendingEditImage || null);
  });

  els.editPasteZone.addEventListener("paste", (e) => {
    const items = e.clipboardData ? [...e.clipboardData.items] : [];
    const imageItem = items.find(item => item.type.startsWith("image/"));
    if (!imageItem) return;

    e.preventDefault();
    const blob = imageItem.getAsFile();
    const reader = new FileReader();
    reader.onload = () => {
      pendingEditImage = reader.result;
      els.editImageUrlInput.value = "";
      updateEditPreview(pendingEditImage);
    };
    reader.readAsDataURL(blob);
  });

  els.saveEditBtn.addEventListener("click", () => {
    const image = (pendingEditImage || "").trim();

    try {
      if (state.editingCover) {
        if (!state.currentCity) return;
        const key = cityKeyFor(state.currentCity);
        if (image) {
          state.cityCovers[key] = image;
        } else {
          delete state.cityCovers[key];
        }
        localStorage.setItem("detour_city_covers", JSON.stringify(state.cityCovers));
      } else {
        if (!state.editingItemId) return;
        const edit = {};
        const description = els.editDescriptionInput.value.trim();
        if (image) edit.image = image;
        if (description) edit.description = description;
        state.cardEdits[state.editingItemId] = edit;
        localStorage.setItem("detour_card_edits", JSON.stringify(state.cardEdits));
      }
    } catch (err) {
      alert("Couldn't save that image locally — it may be too large. Try a smaller image or an image URL instead.");
      return;
    }

    const wasCover = state.editingCover;
    state.editingItemId = null;
    state.editingCover = false;
    els.editCardModal.close();

    if (wasCover) renderHero();
    else renderRecommendations();
  });

  els.resetEditBtn.addEventListener("click", () => {
    if (state.editingCover) {
      if (!state.currentCity) return;
      delete state.cityCovers[cityKeyFor(state.currentCity)];
      localStorage.setItem("detour_city_covers", JSON.stringify(state.cityCovers));
      state.editingCover = false;
      els.editCardModal.close();
      renderHero();
      return;
    }

    if (!state.editingItemId) return;
    delete state.cardEdits[state.editingItemId];
    localStorage.setItem("detour_card_edits", JSON.stringify(state.cardEdits));
    state.editingItemId = null;
    els.editCardModal.close();
    renderRecommendations();
  });

  /* ---------- Add New modal (manual entry or link extraction) ---------- */

  function setAddMode(mode) {
    const isLink = mode === "link";
    els.addNewModeToggle.querySelectorAll(".segmented-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.addMode === mode);
    });
    els.addManualPane.style.display = isLink ? "none" : "flex";
    els.addLinkPane.style.display = isLink ? "flex" : "none";
    els.manualSaveBtn.style.display = isLink ? "none" : "block";
    els.importAddSelectedBtn.style.display = "none";
  }

  els.addNewBtn.addEventListener("click", () => {
    if (!state.currentCity) return;

    importCandidates = [];
    importSourceUrl = "";
    els.manualName.value = "";
    els.manualDuration.value = "";
    els.manualLocation.value = "";
    els.manualCost.value = "";
    els.manualImage.value = "";
    els.manualDescription.value = "";
    els.manualErrorBox.style.display = "none";
    els.importUrlInput.value = "";
    els.importResultsList.innerHTML = "";
    els.importErrorBox.style.display = "none";
    setAddMode("manual");
    els.addNewModal.showModal();
  });

  els.closeAddNewBtn.addEventListener("click", () => els.addNewModal.close());

  els.addNewModeToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".segmented-btn");
    if (!btn) return;
    setAddMode(btn.dataset.addMode);
  });

  els.manualSaveBtn.addEventListener("click", () => {
    const name = els.manualName.value.trim();
    if (!name) {
      els.manualErrorBox.textContent = "Give it a name first.";
      els.manualErrorBox.style.display = "block";
      return;
    }
    if (!state.currentCity) return;

    state.currentCity.items.push({
      id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      category: els.manualCategory.value,
      zone: "",
      location: els.manualLocation.value.trim(),
      description: els.manualDescription.value.trim(),
      duration: els.manualDuration.value.trim() || "1h",
      cost: els.manualCost.value.trim() || "—",
      image: els.manualImage.value.trim(),
      tip: "",
      userAdded: true
    });

    els.addNewModal.close();
    renderHero();
    renderFilterBars();
    renderRecommendations();
  });

  function renderImportResults(results) {
    if (!results.length) {
      els.importResultsList.innerHTML = `<p class="text-muted">No specific recommendations found on that page. Try a different link.</p>`;
      return;
    }
    els.importResultsList.innerHTML = "";

    // Say up front which platform these came from
    const platform = detectPlatform(importSourceUrl);
    if (platform) {
      const banner = document.createElement("div");
      banner.className = "import-source-banner";
      banner.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true" style="fill: ${platform.color}"><path d="${platform.path}"/></svg>
        <span>Found on <strong>${platform.name}</strong> — the link is saved on each card you add.</span>
      `;
      els.importResultsList.appendChild(banner);
    }
    results.forEach((cand, idx) => {
      const row = document.createElement("label");
      row.className = "import-candidate-row";
      row.innerHTML = `
        <input type="checkbox" checked data-import-idx="${idx}">
        <div class="import-candidate-info">
          <span class="todo-badge">${CATEGORY_LABEL[cand.category] || "Landmark"}</span>
          <strong>${cand.name || "Untitled"}</strong>
          <p>${cand.description || ""}</p>
        </div>
      `;
      els.importResultsList.appendChild(row);
    });
    els.importAddSelectedBtn.style.display = "block";
  }

  els.importAnalyzeBtn.addEventListener("click", async () => {
    const url = els.importUrlInput.value.trim();
    if (!url) return;

    if (!state.apiKey) {
      els.importErrorBox.textContent = "Add your Gemini API key first (key icon in the top nav) — it's what reads the page.";
      els.importErrorBox.style.display = "block";
      return;
    }

    els.importErrorBox.style.display = "none";
    els.importAddSelectedBtn.style.display = "none";
    els.importAnalyzeBtn.disabled = true;
    els.importResultsList.innerHTML = `
      <div class="loader-container">
        <div class="spinner"></div>
        <p>Reading the page and pulling out recommendations...</p>
      </div>
    `;

    try {
      const results = await fetchLocationsFromLink(url);
      importCandidates = results;
      importSourceUrl = url;
      renderImportResults(results);
    } catch (err) {
      els.importResultsList.innerHTML = "";
      els.importErrorBox.textContent = err.message;
      els.importErrorBox.style.display = "block";
    } finally {
      els.importAnalyzeBtn.disabled = false;
    }
  });

  els.importAddSelectedBtn.addEventListener("click", () => {
    if (!state.currentCity) return;
    const validCategories = ["visit", "activity", "dish", "eat", "shopping"];
    const checked = [...els.importResultsList.querySelectorAll('input[type="checkbox"]:checked')];

    checked.forEach(cb => {
      const cand = importCandidates[parseInt(cb.dataset.importIdx, 10)];
      if (!cand || !cand.name) return;

      state.currentCity.items.push({
        id: `imported-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: cand.name,
        category: validCategories.includes(cand.category) ? cand.category : "visit",
        subcategory: "",
        zone: cand.zone || "",
        location: cand.location || "",
        description: cand.description || "",
        duration: cand.duration || "1h",
        cost: "—",
        tip: "",
        imported: true,
        // Keep the link so the card can credit where it came from
        sourceUrl: importSourceUrl
      });
    });

    els.addNewModal.close();
    renderHero();
    renderFilterBars();
    renderRecommendations();
  });

  /* ---------- Styled printable itinerary ---------- */

  els.exportItineraryBtn.addEventListener("click", () => {
    if (!state.currentCity) return;
    if (!itineraryHasItems(state.itinerary)) {
      alert("No items in your plan to print yet!");
      return;
    }

    const city = state.currentCity;
    const cover = getCoverImage();
    const start = state.tripStartDate ? new Date(`${state.tripStartDate}T00:00:00`) : null;
    const end = tripEndDate();
    const dateLine = start && end
      ? `${formatDateLabel(start)} — ${formatDateLabel(end)}`
      : `${state.tripDuration} day${state.tripDuration > 1 ? "s" : ""}`;

    const dayBlocks = [];
    for (let day = 1; day <= state.tripDuration; day++) {
      const items = state.itinerary[day] || [];
      if (!items.length) continue;

      const dayDate = start ? new Date(start) : null;
      if (dayDate) dayDate.setDate(start.getDate() + day - 1);

      const hours = hoursForDay(day);
      let running = parseTimeToMinutes(hours.start);

      const rows = items.map(entry => {
        const source = sourceItemFor(entry);
        const edit = getCardEdit(entry.id);
        const image = edit.image || source.image || "";
        const mins = parseDurationToMinutes(entry);

        let time = "All day";
        if (!isMultiDay(entry)) {
          time = formatClock(running);
          running += mins + TRANSIT_BUFFER_MIN;
        }

        const note = getNote(entry.id);
        return `
          <div class="row">
            <div class="row-time">${time}</div>
            <div class="row-thumb">${image ? `<img src="${image}" alt="">` : `<span>${CATEGORY_EMOJI[entry.category] || "📍"}</span>`}</div>
            <div class="row-main">
              <div class="row-title">${entry.name}</div>
              <div class="row-meta">${formatMinutes(mins)}${entry.zone ? ` · ${entry.zone}` : ""}${source.cost && source.cost !== "—" ? ` · ${abbreviateAmounts(source.cost)}` : ""}</div>
              ${note ? `<div class="row-note">${note}</div>` : ""}
            </div>
          </div>
        `;
      });

      dayBlocks.push(`
        <section class="day">
          <div class="day-head">
            <div class="day-num">Day ${day}</div>
            <div class="day-date">${dayDate ? formatDateLabel(dayDate) : `Week ${weekOfDay(day)}`}</div>
          </div>
          ${rows.join("")}
        </section>
      `);
    }

    const html = `
      <!DOCTYPE html>
      <html><head><meta charset="utf-8"><title>${city.name} itinerary</title>
      <style>
        @page { margin: 14mm; }
        * { box-sizing: border-box; }
        body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #222; }
        .cover { position: relative; border-radius: 16px; overflow: hidden; margin-bottom: 28px; background: #2b3d4f; }
        .cover img { width: 100%; height: 220px; object-fit: cover; display: block; }
        .cover-text { position: absolute; inset: auto 0 0 0; padding: 22px 24px;
          background: linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,.75) 100%); color: #fff; }
        .cover h1 { margin: 0 0 4px; font-size: 30px; letter-spacing: -.5px; }
        .cover p { margin: 0; font-size: 13px; opacity: .9; }
        .day { break-inside: avoid; page-break-inside: avoid; margin-bottom: 22px; }
        .day-head { display: flex; align-items: baseline; gap: 10px; border-bottom: 2px solid #222;
          padding-bottom: 6px; margin-bottom: 12px; }
        .day-num { font-size: 17px; font-weight: 800; }
        .day-date { font-size: 12px; color: #6a6a6a; }
        .row { display: flex; gap: 12px; align-items: flex-start; padding: 9px 0;
          border-bottom: 1px solid #ebebeb; break-inside: avoid; page-break-inside: avoid; }
        .row-time { width: 68px; flex: 0 0 68px; font-size: 12px; font-weight: 700; color: #ff385c; padding-top: 12px; }
        .row-thumb { width: 62px; height: 62px; flex: 0 0 62px; border-radius: 10px; overflow: hidden;
          background: #f2f2f2; display: flex; align-items: center; justify-content: center; font-size: 22px; }
        .row-thumb img { width: 100%; height: 100%; object-fit: cover; }
        .row-main { flex: 1; padding-top: 4px; }
        .row-title { font-size: 14px; font-weight: 700; margin-bottom: 2px; }
        .row-meta { font-size: 11.5px; color: #6a6a6a; }
        .row-note { margin-top: 5px; font-size: 11.5px; color: #3f3f3f; font-style: italic;
          background: #f7f7f7; border-left: 2px solid #ddd; padding: 5px 8px; border-radius: 4px; }
        .foot { margin-top: 26px; font-size: 10.5px; color: #929292; text-align: center; }
      </style></head>
      <body>
        <div class="cover">
          ${cover ? `<img src="${cover}" alt="">` : `<div style="height:220px"></div>`}
          <div class="cover-text">
            <h1>${city.name}</h1>
            <p>${dateLine} · ${Object.values(state.itinerary).reduce((n, d) => n + d.length, 0)} planned stops</p>
          </div>
        </div>
        ${dayBlocks.join("")}
        <div class="foot">Made with Detour · ${new Date().toLocaleDateString()}</div>
      </body></html>
    `;

    const win = window.open("", "_blank");
    if (!win) {
      alert("Your browser blocked the print window — allow pop-ups for this page and try again.");
      return;
    }
    win.document.write(html);
    win.document.close();
    // Give the images a moment to load so they appear in the PDF
    win.addEventListener("load", () => setTimeout(() => win.print(), 600));
  });

  window.addEventListener("resize", () => {
    updateItineraryColumns();
    if (mapInstance) mapInstance.invalidateSize();
  });

  init();
});
