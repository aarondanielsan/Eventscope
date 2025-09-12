import pdfplumber
import csv
import re
import os
from tkinter import Tk, filedialog, messagebox

# -------------------------
# Dictionaries
# -------------------------
FUNCTION_TYPES = [
    "Meeting", "Breakout", "Breakfast", "Lunch", "Dinner", "Reception",
    "Cocktail Reception", "Board Meeting", "General Session", "Set Up",
    "Holding Room", "Dance", "Ceremony", "Brunch", "Box Lunch",
    "PM Break", "AM Break", "Coffee Break", "Continuous Break",
    "Hospitality Room", "24 Hour Hold", "Storage", "Office",
    "Registration", "Rehearsal", "Special", "Buffet", "Exhibits",
    "Continental Breakfast", "Teardown", "No Agenda Hold"
]

FUNCTION_SPACES_HINTS = [
    "Director's Room", "The Founders Room",
    "Legacy Ballroom", "Legacy Ballroom I", "Legacy Ballroom II",
    "Legacy I", "Legacy II", "Legacy Prefunction",
    "The Gallery", "Gallery", "Gallery I", "Gallery II",
    "Gallery Prefunction", "Gallery I Prefunction", "Gallery II Prefunction",
    "The Gallery Lounge",
    "Trade Root Restaurant", "Boardroom", "Envoy", "Diplomat", "Ambassador",
    "Plaza I", "Plaza II", "Plaza III", "Plaza II & III", "Plaza", "Plaza Prefunction",
    "Salon I", "Salon II", "Salon III", "Salon IV", "Salon V",
    "Salon VI", "Salon VII", "Salon VIII",
    "Prefunction", "2nd Floor Prefunction", "Whitley Prefunction",
    "Consulate", "Delegate", "Attache", "Charge",
    "The Whitley Ballroom", "Whitley Ballroom"
]

SETUP_STYLES = [
    "Conference", "Rounds of 10", "Rounds of 8", "Rounds of 6",
    "Chevron Theatre", "Schoolroom", "U-Shape", "Hollow Square",
    "Cocktail Rounds", "Theatre", "Special",
    "Crescent Rounds", "Lounge", "Storage"
]

GROUPINGS = {
    "Whitley Ballroom": ["Salon I", "Salon II", "Salon III", "Salon IV",
                         "Salon V", "Salon VI", "Salon VII", "Salon VIII"],
    "Plaza Ballroom": ["Plaza I", "Plaza II", "Plaza III"],
    "Legacy Ballroom": ["Legacy I", "Legacy II"],
}

ROMAN_ORDER = {
    "I": 1, "II": 2, "III": 3, "IV": 4,
    "V": 5, "VI": 6, "VII": 7, "VIII": 8
}

# -------------------------
# Regex
# -------------------------
TIME_RANGE_RE = re.compile(r"(\d{1,2}:\d{2}\s?[AP]M)\s*[-–—]\s*(\d{1,2}:\d{2}\s?[AP]M)")
DATE_LINE_RE = re.compile(r"^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), .* \d{4}$", re.I)
COUNTS_RE = re.compile(r"^\d+/\d+/(?:\d+|__)$")
ORDER_NO_RE = re.compile(r"\b\d{5,}\b")
Y_FLAG_RE = re.compile(r"\bY\b")

MEAL_BREAK_TYPES = {
    "Breakfast", "Lunch", "Dinner", "AM Break", "PM Break",
    "Coffee Break", "Continuous Break", "Box Lunch", "Buffet", "Continental Breakfast"
}

# -------------------------
# Helpers
# -------------------------
def roman_to_int(r: str) -> int:
    return ROMAN_ORDER.get(r, 999)

def split_roman_list(s: str) -> list[str]:
    cleaned = re.sub(r"\s*(?:&|and)\s*", ",", s, flags=re.I)
    parts = [p.strip() for p in cleaned.split(",") if p.strip()]
    return [p for p in parts if re.fullmatch(r"[IVX]+", p)]

def expand_compound_prefix(line_text: str) -> list[str]:
    subs = []
    for m in re.finditer(r"\bSalon\b\s+([IVX]+(?:\s*,\s*[IVX]+)*(?:\s*(?:&|and)\s*[IVX]+)?)", line_text, re.I):
        subs.extend([f"Salon {r}" for r in split_roman_list(m.group(1))])
    for m in re.finditer(r"\bPlaza\b\s+([IVX]+(?:\s*,\s*[IVX]+)*(?:\s*(?:&|and)\s*[IVX]+)?)", line_text, re.I):
        subs.extend([f"Plaza {r}" for r in split_roman_list(m.group(1))])
    for m in re.finditer(r"\bLegacy\b\s+([IVX]+(?:\s*,\s*[IVX]+)*(?:\s*(?:&|and)\s*[IVX]+)?)", line_text, re.I):
        subs.extend([f"Legacy {r}" for r in split_roman_list(m.group(1))])
    return subs

def expand_grouped_space(line_text: str, primary_space: str | None) -> str | None:
    compound = set(expand_compound_prefix(line_text))
    for ballroom, subs in GROUPINGS.items():
        for sub in subs:
            if re.search(rf"\b{re.escape(sub)}\b", line_text):
                compound.add(sub)
    if not compound:
        return primary_space
    matched_whitley = [s for s in compound if s.startswith("Salon ")]
    matched_plaza   = [s for s in compound if s.startswith("Plaza ")]
    matched_legacy  = [s for s in compound if s.startswith("Legacy ")]
    if matched_whitley:
        romans_sorted = sorted({s.split()[-1] for s in matched_whitley}, key=roman_to_int)
        return f"Whitley Ballroom ({', '.join([f'Salon {r}' for r in romans_sorted])})"
    if matched_plaza:
        romans_sorted = sorted({s.split()[-1] for s in matched_plaza}, key=roman_to_int)
        return f"Plaza Ballroom ({', '.join([f'Plaza {r}' for r in romans_sorted])})"
    if matched_legacy:
        romans_sorted = sorted({s.split()[-1] for s in matched_legacy}, key=roman_to_int)
        return f"Legacy Ballroom ({', '.join([f'Legacy {r}' for r in romans_sorted])})"
    return primary_space

def detect_function_type(text: str) -> str | None:
    if re.search(r"\bContinental\b", text, re.I):
        return "Continental Breakfast"
    for f in sorted(FUNCTION_TYPES, key=len, reverse=True):
        if re.search(rf"\b{re.escape(f)}\b", text, re.I):
            return f
    return None

def detect_setup_style(text: str) -> str | None:
    for s in sorted(SETUP_STYLES, key=len, reverse=True):
        if re.search(rf"\b{re.escape(s)}\b", text, re.I):
            return s
    return None

def detect_space(text: str) -> str | None:
    for hint in FUNCTION_SPACES_HINTS:
        if re.search(rf"\b{re.escape(hint)}\b", text):
            return hint
    return None

# -------------------------
# Main PDF → CSV
# -------------------------
def parse_pdf_to_csv(pdf_path):
    rows = []
    current_company, current_event, current_date = None, None, None
    last_space_by_event = {}

    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ""
            for line in text.split("\n"):
                l = line.strip()
                if not l:
                    continue

                if "Quote #:" in l:
                    current_company = l.split("Quote #:")[0].strip()
                    continue
                if "Folio #:" in l:
                    ev = re.match(r"(.+?)\s+Folio #:", l)
                    if ev:
                        current_event = ev.group(1).strip()
                    continue
                if DATE_LINE_RE.match(l):
                    current_date = l.strip()
                    continue

                t = TIME_RANGE_RE.search(l)
                if not t:
                    continue

                start_time, end_time = t.groups()
                function_type = detect_function_type(l)
                setup_style   = detect_setup_style(l)
                function_space = detect_space(l)
                function_space = expand_grouped_space(l, function_space)

                if function_space and COUNTS_RE.fullmatch(function_space.strip()):
                    function_space = None

                if not function_space and function_type in (MEAL_BREAK_TYPES | {"Meeting", "Rehearsal", "Exhibits"}):
                    if (current_company, current_event) in last_space_by_event:
                        function_space = last_space_by_event[(current_company, current_event)]

                if not function_space:
                    continue

                last_space_by_event[(current_company, current_event)] = function_space

                rows.append([
                    current_company or "", current_event or "", current_date or "",
                    start_time, end_time,
                    function_type or "", function_space or "", setup_style or "", l
                ])

    base = os.path.splitext(pdf_path)[0]
    csv_path = f"{base}_parsed.csv"
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([
            "Company Name", "Event Name", "Day of Event",
            "Start Time", "End Time",
            "Function Type", "Function Space", "Setup Style", "Raw Line"
        ])
        writer.writerows(rows)
    return csv_path

# -------------------------
# Run as simple app
# -------------------------
if __name__ == "__main__":
    root = Tk(); root.withdraw()
    pdf_path = filedialog.askopenfilename(
        title="Select PDF File", filetypes=[("PDF Files", "*.pdf")]
    )
    if pdf_path:
        out_csv = parse_pdf_to_csv(pdf_path)
        messagebox.showinfo("Done", f"✅ CSV file created:\n{out_csv}")
    else:
        print("No file selected.")
