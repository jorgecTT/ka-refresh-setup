"""Build the "Update from Doc" demo from ONE description of the article.

Outputs (next to this file):
  demo-seed.js          the article as Salesforce HTML (what is published today),
                        pasted into tools/ka-write-probe.user.js between the
                        DEMO-SEED markers
  KA demo - changes.docx  the writer's copy of the article with the changes
                        marked: red strikethrough = delete, green = add

Run: python3 tools/demo/build_demo.py
The article is made up (generic content, labeled DEMO). Nothing here is real guidance.
"""
import json
import os
import re

from docx import Document
from docx.enum.text import WD_COLOR_INDEX  # noqa: F401  (kept for readers who want highlights)
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor, Inches
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
RED = RGBColor(0xFF, 0x00, 0x00)
GREEN = RGBColor(0x00, 0x99, 0x33)


# A run: (text, opts). opts: add / dele / b (bold) / i (italic) / href
def R(text, **o):
    return (text, o)


def A(text, **o):
    return (text, dict(o, add=True))


def D(text, **o):
    return (text, dict(o, dele=True))


ARTICLE = [
    ('p', [R('Demo article for the "Update from Doc" test. Not real guidance.', i=True)]),
    ('details', 'Contents', [
        ('ol', [[R('Overview', href='#ov')], [R('How it works', href='#how')], [R('Lead prices', href='#price')],
                [R('Troubleshooting', href='#ts')], [R('Try it', href='#try')], [R('Resources', href='#res')]]),
    ]),
    ('h2', [R('1. Overview')], 'ov'),
    ('h3', [R('a. Updates')]),
    ('ul', [
        [A('Oct 8, 2026: Leads now show the customer\'s preferred contact time.')],
        [R('Sep 30, 2026: Added the steps for the Messages tab.')],
    ]),
    ('h3', [R('b. Key points')]),
    ('ul', [
        [R('Pros get leads that match their services and travel area.')],
        [R('Reply to new leads within '), D('24'), A('12'), R(' hours to keep a strong response rate.')],
        [D('Leads older than 30 days are archived automatically.')],
        [R('Customers can message more than one pro.')],
    ]),
    ('h2', [R('2. How it works')], 'how'),
    ('ol', [
        [R('The pro opens the '), R('Jobs', b=True), R(' tab in the app.')],
        [R('They tap a lead to see the project details.')],
        [A('They check the customer\'s preferred contact time.')],
        [R('They send a quote or a message.')],
    ]),
    ('img', 'jobs-old'),
    ('p', [A('New screenshot of the updated Jobs tab:')], 'img:jobs-new'),
    ('h2', [R('3. Lead prices')], 'price'),
    ('table', [
        [[R('Lead type', b=True)], [R('Typical price', b=True)], [R('Notes', b=True)]],
        [[R('Standard lead')], [D('$15–$45'), A('$20–$50')], [R('Based on category and location')]],
        [[R('Direct lead')], [R('$25–$75')], [R('The customer chose this pro')]],
        [[R('Opportunity')], [R('Free')], [R('Shown to new pros'), A(' in their first 30 days')]],
    ]),
    ('h2', [R('4. Troubleshooting')], 'ts'),
    ('details', 'The pro doesn\'t see new leads', [
        ('p', [R('Check that their targeting is on and their budget isn\'t used up.'), A(' If both look right, ask them to update the app.')]),
    ]),
    ('details', 'A lead was charged twice', [
        ('p', [R('Open a case for the billing team and include the lead ID.')]),
    ]),
    ('h2', [R('5. Try it')], 'try'),
    ('p', [R('Use the Pro App Simulator to walk through the Jobs tab.')]),
    ('figma',),
    ('h2', [R('6. Resources')], 'res'),
    ('ul', [
        [R('Help Center: Leads and opportunities', href='https://help.thumbtack.com/')],
        [R('KA: Pro reports', href='https://thumbtack.lightning.force.com/articles/Knowledge/Pro-reports')],
        [A('KA: Weekly budget (Pro)', href='https://thumbtack.lightning.force.com/articles/Knowledge/Weekly-budget')],
    ]),
]


# ---------- Salesforce HTML (the article as it is today: no green, red still there) ----------
def esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')


def runs_html(runs):
    out = ''
    for text, o in runs:
        if o.get('add'):
            continue
        t = esc(text)
        if o.get('b'):
            t = '<strong>' + t + '</strong>'
        if o.get('i'):
            t = '<em>' + t + '</em>'
        if o.get('href'):
            t = '<a href="' + esc(o['href']) + '"' + ('' if o['href'].startswith('#') else ' target="_blank"') + '>' + t + '</a>'
        out += t
    return out


def all_add(runs):
    return all(o.get('add') for _, o in runs)


def block_html(b):
    k = b[0]
    if k == 'p':
        if all_add(b[1]):
            return ''
        return '<p>' + runs_html(b[1]) + '</p>'
    if k in ('h2', 'h3'):
        idattr = ' id="' + b[2] + '"' if len(b) > 2 else ''
        return '<' + k + idattr + '>' + runs_html(b[1]) + '</' + k + '>'
    if k in ('ul', 'ol'):
        return '<' + k + '>' + ''.join('<li>' + runs_html(it) + '</li>' for it in b[1] if not all_add(it)) + '</' + k + '>'
    if k == 'table':
        rows = ''
        for i, row in enumerate(b[1]):
            tag = 'th' if i == 0 else 'td'
            rows += '<tr>' + ''.join('<' + tag + ' style="border:1px solid #c9c9c9;padding:4px 8px">' + runs_html(c) + '</' + tag + '>' for c in row) + '</tr>'
        return '<table style="border-collapse:collapse;width:100%"><tbody>' + rows + '</tbody></table>'
    if k == 'details':
        return '<details><summary>' + esc(b[1]) + '</summary>' + ''.join(block_html(x) for x in b[2]) + '</details>'
    if k == 'img':
        return '<p id="kwp-seed-img-' + b[1] + '"><br></p>'   # the probe pastes a real picture here
    if k == 'figma':
        return '<p>{{FIGMA_IFRAME}}</p>'
    raise ValueError(k)


seed_html = ''.join(block_html(b) for b in ARTICLE)


# ---------- The writer's Doc: same text, changes marked ----------
def make_png(path, title, sub, color):
    img = Image.new('RGB', (720, 260), color)
    d = ImageDraw.Draw(img)
    try:
        f1 = ImageFont.truetype('DejaVuSans-Bold.ttf', 34)
        f2 = ImageFont.truetype('DejaVuSans.ttf', 22)
    except OSError:
        f1 = f2 = ImageFont.load_default()
    d.text((30, 70), title, fill='white', font=f1)
    d.text((30, 140), sub, fill='white', font=f2)
    img.save(path)


old_png = os.path.join(HERE, 'demo-jobs-old.png')
new_png = os.path.join(HERE, 'demo-jobs-new.png')
make_png(old_png, 'Jobs tab (demo)', 'Screenshot already in the article', (0, 159, 217))
make_png(new_png, 'Jobs tab, updated (demo)', 'NEW screenshot added in the Doc', (0, 153, 51))


def add_hyperlink(par, url, text, color=None, strike=False):
    rid = par.part.relate_to(url, 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink', is_external=True)
    h = OxmlElement('w:hyperlink')
    h.set(qn('r:id'), rid)
    r = OxmlElement('w:r')
    rpr = OxmlElement('w:rPr')
    if color:
        c = OxmlElement('w:color'); c.set(qn('w:val'), color); rpr.append(c)
    if strike:
        rpr.append(OxmlElement('w:strike'))
    u = OxmlElement('w:u'); u.set(qn('w:val'), 'single'); rpr.append(u)
    r.append(rpr)
    t = OxmlElement('w:t'); t.text = text; t.set(qn('xml:space'), 'preserve'); r.append(t)
    h.append(r)
    par._p.append(h)


def put_runs(par, runs):
    for text, o in runs:
        color = '009933' if o.get('add') else ('FF0000' if o.get('dele') else None)
        if o.get('href') and not o['href'].startswith('#'):
            add_hyperlink(par, o['href'], text, color, o.get('dele'))
            continue
        r = par.add_run(text)
        r.bold = bool(o.get('b'))
        r.italic = bool(o.get('i'))
        if o.get('add'):
            r.font.color.rgb = GREEN
        if o.get('dele'):
            r.font.color.rgb = RED
            r.font.strike = True


doc = Document()
doc.styles['Normal'].font.name = 'Arial'
doc.styles['Normal'].font.size = Pt(10)


def doc_block(b):
    k = b[0]
    if k == 'p':
        p = doc.add_paragraph()
        put_runs(p, b[1])
        if len(b) > 2 and b[2].startswith('img:'):
            p.add_run().add_picture(new_png, width=Inches(3.6))
    elif k in ('h2', 'h3'):
        p = doc.add_heading(level=2 if k == 'h2' else 3)
        put_runs(p, b[1])
    elif k in ('ul', 'ol'):
        for it in b[1]:
            p = doc.add_paragraph(style='List Bullet' if k == 'ul' else 'List Number')
            put_runs(p, it)
    elif k == 'table':
        t = doc.add_table(rows=len(b[1]), cols=len(b[1][0]))
        t.style = 'Table Grid'
        for i, row in enumerate(b[1]):
            for j, cell in enumerate(row):
                par = t.cell(i, j).paragraphs[0]
                put_runs(par, cell)
    elif k == 'details':
        p = doc.add_paragraph()
        r = p.add_run('▶ ' + b[1]); r.bold = True
        for x in b[2]:
            doc_block(x)
    elif k == 'img':
        doc.add_paragraph().add_run().add_picture(old_png, width=Inches(3.6))
    elif k == 'figma':
        pass   # the Content Index Doc does not show the embedded prototype


for b in ARTICLE:
    doc_block(b)
docx_path = os.path.join(HERE, 'KA demo - changes.docx')
doc.save(docx_path)

with open(os.path.join(HERE, 'demo-seed.js'), 'w') as f:
    f.write('  const DEMO_TITLE = ' + json.dumps('Demo: Leads and messages quick guide (Pro)') + ';\n')
    f.write('  const DEMO_SEED = ' + json.dumps(seed_html, ensure_ascii=True) + ';\n')

# Patch the probe between its markers.
probe = os.path.join(HERE, '..', 'ka-write-probe.user.js')
src = open(probe, encoding='ascii').read()
block = open(os.path.join(HERE, 'demo-seed.js')).read()
src = re.sub(r'(  // DEMO-SEED-START\n).*?(  // DEMO-SEED-END\n)', lambda m: m.group(1) + block + m.group(2), src, flags=re.S)
open(probe, 'w', encoding='ascii').write(src)
print('seed', len(seed_html), 'chars ->', probe)
print('doc  ->', docx_path)
