# Maps Data Extractor — Chrome Extension for Google Maps

A Manifest V3 Chrome extension that automatically searches Google Maps for any
profession/business category across multiple areas (up to **1000 areas**),
extracts business **Name, Full Address and Phone Number** for every result,
walks through all available result pages automatically, and exports everything
into a ready-to-open **Excel (.xlsx)** file.

It fixes the two main limitations of the commonly used "Instant Data Scraper"
style extensions:

1. **No automatic multi-area searching** — you never type each search manually.
   The extension combines `Profession in Area` for every area on your list.
2. **No automatic pagination** — next result sets are discovered and processed
   automatically (scroll-based loading plus the on-page "Next page" controls).

---

## Features

- Input **1 – 1000 areas** (one per line) and a **profession / business category**.
- Runs each search **sequentially**: `Bookstore in Bopal, Ahmedabad` →
  `Bookstore in Navrangpura, Ahmedabad` → ... → all areas done.
- Extracts per result: **Name**, **Full Address**, **Phone Number** (missing
  values stay blank instead of breaking the run).
- **Automatic result-set handling**: clicks "Next page"-style controls when
  present, waits for the article list to actually change (identity-based change
  detection, not just scroll height), falls back to scroll-based loading, and
  continues until no more results appear. Prevents infinite loops and duplicate
  extraction across pages.
- **"Temporarily closed" skip**: businesses marked **Temporarily closed** are
  detected on the result card (and re-checked on the detail panel after
  opening) and are skipped instead of being saved. Places that are merely
  "Closed" for the day are still collected, since "Closed" is just closing
  hours, not a permanent status.
- **Fast, DOM-driven waiting**: waits on the DOM showing phone/address instead
  of fixed sleeps, and retries a limited number of times before moving on.
- **Automatic area advancement**: after one area is exhausted, the extension
  navigates to the next area's search by itself.
- **Duplicate removal** using a normalized `Name + Address + Phone` key,
  applied live (and again before export).
- **Live progress UI**: status, current area, area progress, current search,
  results found, current page, **page progress (e.g. 17 / 20)**,
  **temporarily closed skipped**, total records, duplicates removed, plus a
  live status line (loading / processing / moving to next area / paused …).
- **Start / Pause / Resume / Stop / Reset** controls. Data is preserved when you
  stop, pause, or even navigate away.
- **Data persistence**: records are saved to `chrome.storage.local`
  continuously, so an unexpected reload / crash does not wipe progress.
- **Excel export** via bundled SheetJS — columns:
  `Area | Profession | Name | Address | Phone | Website | Rating | Reviews |
  Hours | Plus Code | Category | Price Level | Google Maps Link | All Visible Data`.
- **Error handling**: retries loading, detects "no results", blocked/captcha
  pages, missing detail panels, etc., without discarding collected data.

---

## Project structure

```
.
├── manifest.json                  MV3 manifest (permissions, content scripts)
├── README.md                      This file
├── icons/                         Extension icons (16/32/48/128)
├── lib/
│   └── xlsx.full.min.js           SheetJS — used by the popup to build .xlsx
├── background/
│   └── service-worker.js          Badge + completion/error notifications
├── content/                       Runs isolated on google.com/maps pages
│   ├── selectors.js               ALL Google Maps selectors/heuristics in one place
│   ├── extract.js                 Field parsing: name, address, phone, dedupe key
│   ├── navigation.js              URL building, waiting, scrolling, clicking
│   ├── runner.js                  The job engine (area queue, pagination, persistence)
│   └── content.js                 Message handler + resume-on-load entry point
└── popup/
    ├── popup.html                 The extension UI
    ├── popup.css                  Styling
    └── popup.js                   Controls, live progress, Excel export
```

---

## Installation (load unpacked with Developer Mode)

1. Download / copy this folder anywhere on your computer, e.g.
   `B:\Study\Projects\VibeCoding\Data Scrapping`.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked**.
5. Select the **project folder** (the one containing `manifest.json`).
6. The extension "Maps Data Extractor" appears. Pin it to the toolbar if you like.
7. Re-open Chrome with any Google Maps tab. The content script activates on
   `google.com/maps` pages automatically.

**To update code**: edit files, then press the refresh (↻) icon on the extension
card in `chrome://extensions/` and reload your Maps tab.

---

## How to use

1. Open **Google Maps** in Chrome at `https://www.google.com/maps`.
2. Click the extension icon → popup opens.
3. **Areas** — type one area per line, e.g.:

   ```
   Bopal, Ahmedabad
   Navrangpura, Ahmedabad
   Sargasan, Gandhinagar
   ```

   The counter shows how many areas are entered (min 1, max 1000).

4. **Profession** — e.g. `Bookstore`, `Dentist`, `Gyms`, `Hospitals`, `Coaching`.
5. Click **START EXTRACTION**.
6. The extension takes over the tab and for every area:
   - sets the search to `Profession in Area` (e.g. `Bookstore in Bopal, Ahmedabad`),
   - waits for results,
   - opens each result to read name/address/phone,
   - moves to the next result set until none remain,
   - then moves to the next area automatically.
7. Do not navigate away or manually edit the search while it runs
   (the extension coordinates page loads/resumes on its own).
8. When finished: status shows **Completed**, the summary card appears, and you
   can click **DOWNLOAD EXCEL**.

> You can **close the popup** mid-run — the job continues in the tab.
> Reopen the popup any time to watch progress.

### Controls

| Button          | Effect                                                        |
|-----------------|---------------------------------------------------------------|
| START EXTRACTION| Begins a new job (new areas/profession overwrite the old list) |
| Pause / Resume  | Suspends / resumes at the next safe point                     |
| Stop            | Stops the job, keeps everything collected so far              |
| DOWNLOAD EXCEL  | Exports collected records to an .xlsx file                    |
| Reset           | Clears inputs for a new job                                   |

---

## How it works

### Architecture and responsibilities

| Layer | File(s) | Responsibility |
|---|---|---|
| **UI** | `popup/popup.html|css|js` | Inputs, buttons, live progress, Excel export. Polls `chrome.storage.local` every ~800 ms and also listens to `GME_STATE` messages for instant updates. |
| **Controller** | `content/content.js` | Receives `GME_START/PAUSE/RESUME/STOP/RESET/GET_STATE` from the popup, and on every page load checks whether a job is active and resumes it. |
| **Engine** | `content/runner.js` | The full state machine: area queue, per-area extraction loop, pagination, pause/stop gates, continuous persistence, duplicate filtering. |
| **Maps adapter** | `content/selectors.js` `content/navigation.js` `content/extract.js` | Everything that touches Google Maps DOM: finding the feed, articles, detail panel, address/phone, URL search navigation, waits/scrolling. |
| **Service worker** | `background/service-worker.js` | Lightweight: updates the action badge and shows notifications when a job finishes or errors. Does **not** run the job (the tab does), so closing it never stops extraction. |
| **Storage** | `chrome.storage.local` (`unlimitedStorage` granted) | Job state + record batches, so data survives reloads. |

### The extraction loop (per area)

```
START
 └─ ensure URL = "Profession in Area"        (navigates there if needed)
     └─ wait for result feed to render
         └─ loop:
             ├─ list current result articles
             ├─ for each NEW article:
             │    ├─ click it → wait for detail panel to load
             │    ├─ extract Name / Address / Phone (with selector fallbacks)
             │    ├─ dedupe key = normalize(name) + normalize(address) + digits(phone)
             │    └─ save record (buffered → flushed to storage in batches of 25)
└─ advance to next result set:
                  ├─ scroll feed; wait for NEW article identities to appear
                  ├─ if "Next page" button present & enabled: click it and wait
                  │  for the article-identity set to change (retries, then falls
                  │  back to scroll probing); button missing/disabled → done
                  └─ stop when no new articles appear after bounded retries
          └─ finish area → flush storage → next area (navigate) → REPEAT
ALL AREAS DONE
 └─ status = completed → notification/badge → popup shows summary → DOWNLOAD EXCEL
```

Because each area navigation reloads the page, every state transition is written
to storage **before** navigating; the content script's `onPageReady()` re-hydrates
from storage, verifies the URL matches the current area, then continues.

### Google Maps adapters (maintainability)

`selectors.js` centralizes every selector and heuristic. Google Maps changes its
DOM often — when extraction stops working, this is the first file to update:

- Feed / result containers: `div[role="feed"]`, `div[role="article"]`
- Article links: `a[href*="/maps/place/"]`
- Detail panel name: `h1`, `.DUwDvf`, …
- Detail panel address: `[data-item-id*="address"]`
- Detail panel phone: `[href^="tel:"]`, `[data-item-id*="phone"]`
- Next-page controls: `button[aria-label*="Next page"/"Next"/"More results"]`

Each extraction uses **multiple fallback selectors plus text heuristics**
(address scoring, phone regex) so a renamed CSS class does not break the whole
scraper.

### Duplicate detection

A business is considered a duplicate when the normalized triple
`Name + Address + Phone` (lowercased name/address, numeric-only phone) already
exists. Duplicates are skipped live and counted in **Duplicates Removed**; a
final dedupe pass also runs at export time.

### Persistence format

```
gme_job                      current state (status, area index, counts, …)
gme_rec_meta                 { jobId, batchCount, total }
gme_rec_batch_<jobId>_<n>    batches of up to 25 records
gme_pending_start            {areas, profession} set when the popup must hand a
                             job to a Maps tab that is still loading
gme_area_stats               per-area summary (for reference)
```

`unlimitedStorage` is requested so large runs (up to 1000 areas) do not hit the
default quota.

---

## Excel export details

- Generated in the popup with the bundled SheetJS (`lib/xlsx.full.min.js`).
- Sheet name: `Business Data`.
- Columns: `Area`, `Profession`, `Name`, `Address`, `Phone Number`, `Website`,
  `Rating`, `Number of Reviews`, `Hours`, `Plus Code`, `Category`,
  `Price Level`, `Google Maps Link`, and `All Visible Data` (the complete
  visible text of each business's detail panel, wrapped and top-aligned).
- Column widths are pre-set; the file opens in Microsoft Excel, LibreOffice,
  Google Sheets, and Numbers.
- If reviewing on a machine without a working `XLSX` bundle, the export falls
  back to a UTF-8 CSV (also Excel-compatible).

---

## Known limitations / notes

- Google Maps is dynamic and occasionally updates its layout. If you run it and
  no records appear, check the **Error** box; the extension reports when it
  cannot find the results feed or when Maps shows a consent/captcha page. Update
  `content/selectors.js` as needed.
- Clicking each result to read its details is intentionally slower than a page
  scrape (roughly 1–2.5 s per business) but is the reliable way to obtain the
  full address and phone, which are not printed on the result cards.
- The extension works on the **public Google Maps web UI**. Excessive, automated
  use may occasionally be rate-limited by Google; a job can be paused and resumed.
- Running this tool may violate Google's Terms of Service. Use it responsibly,
  for legitimate data collection, and respect applicable laws and ToS of the
  websites you scrape.

---

## Workflow verification (requirements → implementation)

```
INPUT AREAS               popup/areasInput        (1–1000, one per line)
INPUT PROFESSION          popup/professionInput
START                     popup startBtn → GME_START → Runner.startJob
SEARCH PROFESSION + AREA  runner.ensureAreaSearchPage → buildSearchUrl → navigate
WAIT FOR RESULTS          navigation.waitForFeed (long timeout, polling)
EXTRACT NAME/ADDR/PHONE   runner.extractArticle + extract.js (fallback selectors)
CHECK FOR MORE RESULTS    runner.advanceToNextResultSet
PROCESS NEXT PAGE         click next / scroll feed until nothing new loads
NO MORE RESULTS → NEXT AREA   runner.finishArea → navigate → onPageReady resume
ALL AREAS COMPLETE        finishAll → status completed
DEDUPLICATE               live seenSet + popup final dedupe pass
GENERATE EXCEL            SheetJS → workbook → blob download
DOWNLOAD                  DOWNLOAD EXCEL button in the popup
```