# Analytics Club · Certificate Portal

A static website that lets students download their personalised certificates for the **Deep Learning Bootcamp 2025** and **Winter in Data Science (WiDS) 2025** organised by the Analytics Club, IIT Bombay.

Built as a single-page static site — no backend, no database. All student data is bundled into the page at build time. The student's name (and the project name, for WiDS) is overlaid onto the original Canva templates in the browser using HTML5 Canvas, then offered as a PNG download.

---

## How it works

1. The student picks **DL Bootcamp** or **WiDS**.
2. They type their name. Matching is done loosely — case-insensitive, whitespace-tolerant, and middle-name-tolerant.
3. The site shows every certificate they're eligible for:
    - For Bootcamp: any of CV-Basic, CV-Advanced, NLP-Basic, NLP-Advanced.
    - For WiDS: one personalised certificate per project they completed.
4. The displayed name is **always the version from the source CSV/Excel** — even if the student typed "AARAV" in lowercase or skipped a middle name, the certificate shows the official spelling.

---

## Project structure

```
.
├── index.html
├── css/
│   └── style.css
├── js/
│   ├── app.js          # UI logic, name matching, canvas rendering
│   └── data.js         # auto-generated student data (do not edit by hand)
├── assets/
│   ├── logos/
│   │   ├── ugac.jpg
│   │   └── analytics-club.png
│   └── templates/
│       ├── cv-basic.png
│       ├── cv-advanced.png
│       ├── nlp-basic.png
│       ├── nlp-advanced.png
│       └── wids.png
├── build_data.py       # regenerate js/data.js from the source CSVs/XLSX
└── .nojekyll
```

---

## Deploying to GitHub Pages

1. Create a new repo (e.g. `certificates-2025`) and push these files to the `main` branch.
2. In the repo settings → **Pages**, set source to `main` branch / root.
3. The site will be live at `https://<your-username>.github.io/<repo-name>/`.

> The `.nojekyll` file is included so GitHub Pages serves the files as-is without any Jekyll processing.

---

## Updating the student lists

If the CSVs change (for example, a name was misspelled, or another student qualifies):

1. Replace the source files (the four bootcamp CSVs and the WiDS XLSX) in the location used by `build_data.py`.
2. Run `python3 build_data.py` to regenerate `js/data.js`.
3. Commit and push.

The names live entirely inside `js/data.js`, so updating is a single regeneration step.

---

## Name matching details

- Names are normalised before comparison: lowercased, accent-stripped, punctuation stripped, multiple spaces collapsed.
- A match counts if **all of the user's tokens are a subset of the CSV name's tokens, or vice versa**, OR if the **first and last tokens both match**. This handles:
    - Wrong capitalisation (`aarav sharma` vs `Aarav Sharma`)
    - Skipped middle name (`Aarav Sharma` vs `Aarav Kumar Sharma`)
    - Added middle name (the reverse)
- If no strong match is found, the page suggests the closest similar names so the student can self-correct.
- Loose matches based on first name only are *not* accepted as eligibility — too many false positives.

---

## Credits

- Logos: UGAC, Analytics Club
- Certificate templates designed in Canva by the Analytics Club design team
- Site by the Analytics Club Tech team
