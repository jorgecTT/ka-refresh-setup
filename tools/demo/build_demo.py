"""Build the "Update from Doc" demo from ONE description of the article.

Outputs (next to this file):
  demo-seed.js                what is in Salesforce today (one HTML per content box),
                              pasted into tools/ka-write-probe.user.js between the
                              DEMO-SEED markers
  KA demo - changes.docx      the writer's copy of the Content Index Doc with the
                              changes marked: red strikethrough = delete, green = add.
                              Shaped like a real Content Index Doc: page header with
                              the KA details, the title on top, "[Image: ...]" where
                              Salesforce has a picture, "[Embedded content]" for Figma.

Run: python3 tools/demo/build_demo.py
The article is made up (generic content, labeled DEMO). Nothing here is real guidance.
"""
import json
import os
import re

from docx import Document
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import qn, nsdecls
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


def SUB(runs, kind, items):
    """A list item with a sub-list under it."""
    return {'r': runs, 'sub': (kind, items)}


HC = 'https://help.thumbtack.com/'
KA = 'https://thumbtack.lightning.force.com/articles/Knowledge/'

TITLE = [R('Demo: Pro account '), A('complete '), R('guide (Pro)')]

KB = [
    ('p', [R('Demo article for the "Update from Doc" test. It mixes a little of every pro topic. Not real guidance.', i=True)]),
    ('details', 'Contents', [
        ('ol', [[R('Overview', href='#ov')], [R('Getting started', href='#start')], [R('Profile and reviews', href='#profile')],
                [R('Leads and targeting', href='#leads')], [R('Pricing and budget', href='#price')],
                [R('Messages and quotes', href='#msg')], [R('Payments and refunds', href='#pay')],
                [R('Top Pro and badges', href='#badges')], [R('Account safety', href='#safety')],
                [R('Troubleshooting', href='#ts')], [R('Try it', href='#try')],
                [A('Pausing the account')],
                [R('Resources', href='#res')]]),
    ]),
    ('p', [R('Important:', b=True), R(' always check the pro\'s account in the admin tool before you answer.')]),

    ('h2', [R('1. Overview')], 'ov'),
    ('h3', [R('a. Updates')]),
    ('ul', [
        [A('Oct 8, 2026: Added the section about pausing the account.')],
        [R('Sep 30, 2026: Updated the lead prices.')],
        [R('Aug 12, 2026: Added the steps for the Messages tab.')],
    ]),
    ('h3', [R('b. Who this is for')]),
    ('p', [R('Reps who help pros with their account, leads, billing and safety.'), A(' It is also a good start for new hires.')]),
    ('h3', [R('c. Key terms')]),
    ('table', [
        [[R('Term', b=True)], [R('What it means', b=True)]],
        [[R('Lead')], [R('A customer request sent to a pro.')]],
        [[R('Direct lead')], [R('The customer chose this pro '), D('by name'), A('from the search results'), R('.')]],
        [[R('Opportunity')], [R('A lead the pro can choose to pay for.')]],
        ('ADD', [[R('Instant match')], [R('The pro is matched right away, based on their preferences.')]]),
        ('DEL', [[R('Spotlight')], [R('Old name for featured placement.')]]),
    ]),

    ('h2', [R('2. Getting started')], 'start'),
    ('ol', [
        [R('Create the account with an email or phone number.')],
        SUB([R('Add the services they offer.')], 'ul', [
            [R('Pick the main category first.')],
            [A('Add up to 10 related services.')],
        ]),
        [R('Set the travel area.')],
        [R('Add a payment method.')],
        [A('Turn on notifications so no lead is missed.')],
    ]),
    ('img', 'profile-old'),
    ('p', [R('Most pros finish setup in about '), D('15'), A('10'), R(' minutes.')]),

    ('h2', [R('3. Profile and reviews')], 'profile'),
    ('p', [R('A complete profile gets more leads. Pros should add:')]),
    ('ul', [
        [R('A clear profile photo or logo.')],
        [R('An introduction with their experience.')],
        [R('Photos of past work.')],
        [D('A fax number.')],
        [R('Business hours.')],
    ]),
    ('details', 'How reviews work', [
        ('p', [R('Customers can leave a review after the job. The pro can\'t edit a review.')]),
        ('ul', [
            [R('Pros can reply to each review once.')],
            [A('Pros can ask past customers for reviews from the Profile tab.')],
        ]),
    ]),

    ('h2', [R('4. Leads and targeting')], 'leads'),
    ('h3', [R('a. Lead types')]),
    ('p', [R('There are three main lead types. See '), R('Key terms', b=True), R(' above.')]),
    ('h3', [R('b. Targeting preferences')]),
    ('ul', [
        SUB([R('Services')], 'ul', [[R('Job types they want')], [R('Job types they don\'t want')]]),
        SUB([R('Travel area')], 'ul', [[R('Distance from their address')], [A('Specific ZIP codes')]]),
        [R('Availability')],
    ]),
    ('h3', [D('c. Lead quality score')]),
    ('p', [D('Each lead has a hidden quality score.')]),

    ('h2', [R('5. Pricing and budget')], 'price'),
    ('table', [
        [[R('Lead type', b=True)], [R('Typical price', b=True)], [R('Notes', b=True)]],
        [[R('Standard lead')], [D('$15–$45'), A('$20–$50')], [R('Based on category and location')]],
        [[R('Direct lead')], [R('$25–$75')], [R('The customer chose this pro')]],
        [[R('Opportunity')], [R('Free')], [R('Shown to new pros'), A(' in their first 30 days')]],
    ]),
    ('p', [R('The weekly budget is the most a pro spends on leads in a week. It resets every '), D('Sunday'), A('Monday'), R('.')]),
    ('details', 'Example', [
        ('p', [R('A pro with a $100 weekly budget who gets 5 leads at $20 reaches the budget.')]),
        ('p', [A('After that, they stop getting new leads until the budget resets.')]),
    ]),

    ('h2', [R('6. Messages and quotes')], 'msg'),
    ('ol', [
        [R('Open the lead from the '), R('Jobs', b=True), R(' tab.')],
        [R('Read the project details.')],
        [R('Send a quote or a message.')],
        [A('Follow up if the customer doesn\'t answer in 2 days.')],
    ]),
    ('img', 'jobs-old'),
    ('p', [A('New screenshot of the updated Jobs tab:')], 'img:jobs-new'),
    ('p', [R('Tip: pros who reply in the first hour get hired more often.', i=True)]),

    ('h2', [R('7. Payments and refunds')], 'pay'),
    ('ul', [
        [R('Pros pay for leads with the card on file.')],
        [R('Charges show up as Thumbtack on the bank statement.')],
        [R('Pros can see every charge in '), R('Payment history', b=True), R('.')],
    ]),
    ('table', [
        [[R('Reason', b=True)], [R('Credit?', b=True)]],
        [[R('The customer\'s contact info is wrong')], [R('Yes')]],
        [[R('The job is outside the travel area')], [R('Yes')]],
        [[R('The pro changed their mind')], [R('No')]],
        ('ADD', [[R('Duplicate lead from the same customer')], [R('Yes')]]),
    ]),
    ('p', [R('Credit requests are reviewed in '), D('5 to 7'), A('3 to 5'), R(' business days.')]),

    ('h2', [R('8. Top Pro and badges')], 'badges'),
    ('p', [R('Top Pro is a badge for pros with great reviews and fast replies. It is checked every quarter.')]),
    ('ul', [
        [R('At least 4.8 stars')],
        [R('At least 10 reviews')],
        [R('Replies to most leads')],
        [D('Has a website')],
    ]),

    ('h2', [R('9. Account safety')], 'safety'),
    ('ul', [
        [R('Never share the verification code.')],
        [R('Thumbtack will never ask for a password by phone.')],
        [A('Turn on two-step verification in Settings.')],
    ]),
    ('p', [R('If a pro thinks their account was hacked, '), R('escalate to Trust & Safety', b=True), R(' right away.')]),

    ('h2', [R('10. Troubleshooting')], 'ts'),
    ('details', 'The pro doesn\'t see new leads', [
        ('p', [R('Check that targeting is on and the budget isn\'t used up.'), A(' If both look right, ask them to update the app.')]),
    ]),
    ('details', 'A lead was charged twice', [
        ('p', [R('Open a case for the billing team and include the lead ID.')]),
    ]),
    ('details', 'The pro can\'t log in', [
        ('ol', [
            [R('Check the email on the account.')],
            [R('Send a password reset link.')],
            [A('If it still fails, ask them to clear the app cache.')],
        ]),
    ]),

    ('h2', [R('11. Try it')], 'try'),
    ('p', [R('Use the Pro App Simulator to walk through the Jobs tab.')]),
    ('figma',),

    ('h2', [A('12. Pausing the account')]),
    ('p', [A('Pros can pause their account when they are busy or on vacation. Leads stop until they turn it back on.')]),
    ('ol', [
        [A('Go to Settings.')],
        [A('Tap Pause account.')],
        [A('Pick an end date (optional).')],
    ]),

    ('h2', [D('12'), A('13'), R('. Resources')], 'res'),
    ('ul', [
        [R('Help Center: Leads and opportunities', href=HC)],
        [R('Help Center: Payments', href=HC), A(' and refunds', href=HC)],
        [R('KA: Pro reports', href=KA + 'Pro-reports')],
        [A('KA: Weekly budget (Pro)', href=KA + 'Weekly-budget')],
    ]),
]

RELATED = [
    ('h3', [R('Related articles')]),
    ('ul', [
        [R('KA: Lead credits (Pro)', href=KA + 'Lead-credits')],
        [D('KA: Spotlight placement (Pro)', href=KA + 'Spotlight')],
        [R('KA: Top Pro program (Pro)', href=KA + 'Top-Pro')],
        [A('KA: Pausing the account (Pro)', href=KA + 'Pause-account')],
    ]),
]

SUPPORT = [
    ('h3', [R('Internal notes for reps')]),
    ('p', [R('Use these notes when a pro calls or chats in.')]),
    ('table', [
        [[R('Issue', b=True)], [R('Team', b=True)], [R('How fast', b=True)]],
        [[R('Account hacked')], [R('Trust & Safety')], [R('Right away')]],
        [[R('Charged twice')], [R('Billing')], [R('Same day')]],
        [[R('App bug')], [R('Product support')], [D('3'), A('2'), R(' business days')]],
        ('ADD', [[R('Lead fraud')], [R('Trust & Safety')], [R('Same day')]]),
    ]),
    ('p', [R('Always add a note to the case with what you checked.'), A(' Include screenshots when you can.')]),
]

BOXES = [('KB Content', KB), ('Related Content', RELATED), ('Support Content', SUPPORT)]

# Pictures already in Salesforce (the probe draws them) and the new one in the Doc.
DEMO_IMGS = {
    'profile-old': ['Profile setup (demo)', 'Screenshot already in the article', '#009fd9'],
    'jobs-old': ['Jobs tab (demo)', 'Screenshot already in the article', '#009fd9'],
}


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


def item_runs(it):
    return it['r'] if isinstance(it, dict) else it


def list_html(kind, items):
    lis = ''
    for it in items:
        if all_add(item_runs(it)):
            continue
        sub = ''
        if isinstance(it, dict):
            sub = list_html(*it['sub'])
        lis += '<li>' + runs_html(item_runs(it)) + sub + '</li>'
    return '<' + kind + '>' + lis + '</' + kind + '>' if lis else ''


def block_html(b):
    k = b[0]
    if k == 'p':
        return '' if all_add(b[1]) else '<p>' + runs_html(b[1]) + '</p>'
    if k in ('h2', 'h3'):
        if all_add(b[1]):
            return ''
        idattr = ' id="' + b[2] + '"' if len(b) > 2 else ''
        return '<' + k + idattr + '>' + runs_html(b[1]) + '</' + k + '>'
    if k in ('ul', 'ol'):
        return list_html(k, b[1])
    if k == 'table':
        rows = ''
        for i, row in enumerate(b[1]):
            if isinstance(row, tuple):
                if row[0] == 'ADD':
                    continue
                row = row[1]
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


seed = {label: ''.join(block_html(b) for b in blocks) for label, blocks in BOXES}
title_now = ''.join(t for t, o in TITLE if not o.get('add'))


# ---------- The writer's Doc: a copy of the Content Index Doc, changes marked ----------
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


new_png = os.path.join(HERE, 'demo-jobs-new.png')
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


def put_runs(par, runs, force=None):
    for text, o in runs:
        if force:
            o = dict(o, **{force: True})
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

# Lists: two-level definitions (1. / bullet, then a bullet), one numbering per list so each list starts at 1.
numbering = doc.part.numbering_part.element


def abstract(aid, fmt0):
    lvl = lambda i, fmt, txt: ('<w:lvl w:ilvl="%d"><w:start w:val="1"/><w:numFmt w:val="%s"/><w:lvlText w:val="%s"/>'
                               '<w:pPr><w:ind w:left="%d" w:hanging="360"/></w:pPr></w:lvl>') % (i, fmt, txt, 720 * (i + 1))
    xml = ('<w:abstractNum %s w:abstractNumId="%d"><w:multiLevelType w:val="hybridMultilevel"/>' % (nsdecls('w'), aid) +
           lvl(0, fmt0, '%1.' if fmt0 == 'decimal' else '•') + lvl(1, 'bullet', '◦') + '</w:abstractNum>')
    numbering.insert(0, parse_xml(xml))


abstract(90, 'decimal')
abstract(91, 'bullet')


def new_num(kind):
    num = numbering.add_num(90 if kind == 'ol' else 91)
    return num.numId


def list_par(runs, num_id, level):
    p = doc.add_paragraph(style='List Paragraph')
    numPr = p._p.get_or_add_pPr().get_or_add_numPr()
    numPr.get_or_add_ilvl().val = level
    numPr.get_or_add_numId().val = num_id
    put_runs(p, runs)


def doc_list(kind, items, num_id=None, level=0):
    num_id = num_id or new_num(kind)
    for it in items:
        list_par(item_runs(it), num_id, level)
        if isinstance(it, dict):
            doc_list(it['sub'][0], it['sub'][1], num_id, level + 1)


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
        doc_list(k, b[1])
    elif k == 'table':
        rows = [r[1] if isinstance(r, tuple) else r for r in b[1]]
        marks = [r[0] if isinstance(r, tuple) else None for r in b[1]]
        t = doc.add_table(rows=len(rows), cols=len(rows[0]))
        t.style = 'Table Grid'
        for i, row in enumerate(rows):
            for j, cell in enumerate(row):
                put_runs(t.cell(i, j).paragraphs[0], cell, {'ADD': 'add', 'DEL': 'dele'}.get(marks[i]))
    elif k == 'details':
        p = doc.add_paragraph()
        r = p.add_run(b[1] if b[1] == 'Contents' else '▶ ' + b[1]); r.bold = True
        for x in b[2]:
            doc_block(x)
    elif k == 'img':
        p = doc.add_paragraph(); r = p.add_run('[Image: demo-' + b[1] + '.png]'); r.italic = True
    elif k == 'figma':
        p = doc.add_paragraph(); r = p.add_run('[Embedded content]'); r.italic = True


# Page header like the Content Index Docs (KA details), then the title.
hdr = doc.sections[0].header
hdr.paragraphs[0].text = 'Published link: ' + KA + 'Demo-Pro-account-guide'
for line in ['KA ID: 000015532', 'Version: 1', 'Last modified in Salesforce: 2026-10-08', 'Current refresh: 2026-10-08 — Demo', 'Previous refresh: N/A']:
    hdr.add_paragraph(line)
put_runs(doc.add_heading(level=1), TITLE)
for label, blocks in BOXES:
    for b in blocks:
        doc_block(b)
docx_path = os.path.join(HERE, 'KA demo - changes.docx')
doc.save(docx_path)

with open(os.path.join(HERE, 'demo-seed.js'), 'w') as f:
    f.write('  const DEMO_TITLE = ' + json.dumps(title_now) + ';\n')
    f.write('  const DEMO_SEED = ' + json.dumps(seed, ensure_ascii=True) + ';\n')
    f.write('  const DEMO_IMGS = ' + json.dumps(DEMO_IMGS, ensure_ascii=True) + ';\n')

# Patch the probe between its markers.
probe = os.path.join(HERE, '..', 'ka-write-probe.user.js')
src = open(probe, encoding='ascii').read()
block = open(os.path.join(HERE, 'demo-seed.js')).read()
src2 = re.sub(r'(  // DEMO-SEED-START\n).*?(  // DEMO-SEED-END\n)', lambda m: m.group(1) + block + m.group(2), src, flags=re.S)
src2.encode('ascii')
open(probe, 'w', encoding='ascii').write(src2)
print('seed', {k: len(v) for k, v in seed.items()}, '->', probe)
print('doc  ->', docx_path)
