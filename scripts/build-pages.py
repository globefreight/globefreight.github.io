"""Generate standalone GitHub Pages documents from the shared static layout."""

import argparse
from html import escape
from pathlib import Path
import re
from shutil import copytree
from urllib.parse import urlsplit

PAGES = {
    "home": ("", "Freight, Tracking & Support", "Plan a shipment, follow freight updates, and get support with GlobeFreight Express."),
    "tracking": ("tracking/", "Track a Shipment", "Look up freight status, delivery estimates, and the shipment timeline."),
    "milestones": ("milestones/", "Shipment Milestones", "Understand freight milestones from pickup and transit through delivery."),
    "tracking-help": ("tracking-help/", "Tracking Help", "Find your tracking number and answers to common tracking questions."),
    "about": ("about/", "About Us", "Learn how GlobeFreight Express supports freight planning, tracking, and customer enquiries."),
    "design-print": ("design-print/", "Design & Print", "Prepare a design and print inquiry and review the listed U.S. locations."),
    "quote": ("quote/", "Request a Freight Quote", "Send your route, package measurements, and preferred service to request a quote."),
    "contact": ("contact/", "Contact & Complaints", "Report a freight issue or send a design and print inquiry to GlobeFreight Express."),
    "portal": ("portal/", "Team Portal", "Sign in to manage GlobeFreight Express shipments, pickup requests, and customer cases."),
}


def render(template, page, base):
    route, name, description = PAGES[page]
    prefix = "../" if route else "./"
    canonical = base + "/" + route
    title = escape("GlobeFreight Express | " + name, quote=True)
    output = template.replace('<html lang="en">', '<html lang="en" data-clean-pages="true">', 1)
    output = output.replace("__GLOBEFREIGHT_SITE_URL__", escape(base, quote=True))
    output = re.sub(r"<title>[^<]*</title>", f"<title>{title}</title>", output, count=1)
    for meta, value in (
        ('name="description"', description),
        ('property="og:description"', description),
        ('property="og:title"', "GlobeFreight Express | " + name),
        ('property="og:url"', canonical),
    ):
        output = re.sub(
            rf'(<meta {meta} content=")[^"]*(">)',
            lambda match: match[1] + escape(value, quote=True) + match[2],
            output, count=1,
        )
    canonical_tag = f'  <link rel="canonical" href="{escape(canonical, quote=True)}">'
    output = output.replace("</head>", canonical_tag + "\n</head>", 1)
    output = re.sub(r'((?:src|href)=")assets/', lambda match: match[1] + prefix + "assets/", output)

    def replace_route(match):
        name = match[1]
        if name not in PAGES:
            return match[0]
        return f'href="{prefix}{PAGES[name][0]}" data-current-route="{name}"'

    output = re.sub(r'href="#([a-z-]+)"', replace_route, output)
    output = output.replace('href="#" data-home-link', f'href="{prefix}" data-current-route="home" data-home-link')
    output = re.sub(
        r'(data-public-view="([a-z-]+)")(?: hidden)?',
        lambda match: match[1] + ("" if match[2] == page else " hidden"),
        output,
    )
    if page == "portal":
        output = output.replace('<div id="public-page">', '<div id="public-page" hidden>', 1)
        output = output.replace('aria-labelledby="portal-title" hidden', 'aria-labelledby="portal-title"', 1)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--url", required=True)
    args = parser.parse_args()
    base = args.url.rstrip("/")
    parsed = urlsplit(base)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.query or parsed.fragment:
        parser.error("A valid base site URL is required.")
    if args.output.resolve().is_relative_to(args.site.resolve()):
        parser.error("The output must be outside the source site directory.")
    template = (args.site / "index.html").read_text(encoding="utf-8")
    copytree(args.site / "assets", args.output / "assets", dirs_exist_ok=True)
    for name, (route, _, _) in PAGES.items():
        page = args.output / route / "index.html"
        page.parent.mkdir(parents=True, exist_ok=True)
        page.write_text(render(template, name, base), encoding="utf-8")


if __name__ == "__main__":
    main()
