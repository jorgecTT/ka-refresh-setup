# Turn the demo .docx into HTML shaped like Google Docs' "export?format=html" (classes + <style>).
import sys, html
from docx import Document
from docx.oxml.ns import qn
d = Document(sys.argv[1]); out = []; styles = {}; n = [0]
def cls(color, strike, bold, italic):
    key = (color, strike, bold, italic)
    if key not in styles:
        n[0] += 1; css = []
        if color: css.append('color:#' + color)
        if strike: css.append('text-decoration:line-through')
        if bold: css.append('font-weight:700')
        if italic: css.append('font-style:italic')
        styles[key] = ('c%d' % n[0], ';'.join(css) or 'color:#000000')
    return styles[key][0]
def runs(p):
    s = ''
    for el in p._p:
        if el.tag == qn('w:r'):
            from docx.text.run import Run
            r = Run(el, p)
            if el.findall('.//' + qn('w:drawing')): s += '<span class="c0"><img src="https://lh7-rt.googleusercontent.com/docsz/demo-new-image" style="width:300px"></span>'; continue
            col = str(r.font.color.rgb) if r.font.color and r.font.color.type else None
            s += '<span class="%s">%s</span>' % (cls(col, bool(r.font.strike), bool(r.bold), bool(r.italic)), html.escape(r.text))
        elif el.tag == qn('w:hyperlink'):
            rid = el.get(qn('r:id')); url = p.part.rels[rid].target_ref
            for rr in el.findall(qn('w:r')):
                t = ''.join(x.text for x in rr.findall(qn('w:t')))
                c = rr.find(qn('w:rPr')); col = None; st = False
                if c is not None:
                    cc = c.find(qn('w:color')); col = cc.get(qn('w:val')) if cc is not None else None; st = c.find(qn('w:strike')) is not None
                s += '<span class="%s"><a class="c99" href="https://www.google.com/url?q=%s&amp;sa=D">%s</a></span>' % (cls(col, st, False, False), html.escape(url), html.escape(t))
    return s
body = d.element.body; lst = None
for el in body:
    if el.tag == qn('w:p'):
        from docx.text.paragraph import Paragraph
        p = Paragraph(el, d); st = p.style.name
        kind = 'ul' if st == 'List Bullet' else 'ol' if st == 'List Number' else None
        if kind != lst:
            if lst: out.append('</%s>' % lst)
            if kind: out.append('<%s class="lst-kix_x">' % kind)
            lst = kind
        if kind: out.append('<li class="lb5 li-bullet-0">%s</li>' % runs(p)); continue
        tag = 'h2' if st == 'Heading 2' else 'h3' if st == 'Heading 3' else 'p'
        out.append('<%s class="pb2">%s</%s>' % (tag, runs(p), tag))
    elif el.tag == qn('w:tbl'):
        if lst: out.append('</%s>' % lst); lst = None
        from docx.table import Table
        t = Table(el, d); out.append('<table class="c9">')
        for row in t.rows:
            out.append('<tr>' + ''.join('<td class="tc7">' + ''.join('<p class="pb2">%s</p>' % runs(pp) for pp in c.paragraphs) + '</td>' for c in row.cells) + '</tr>')
        out.append('</table>')
if lst: out.append('</%s>' % lst)
css = ''.join('.%s{%s}' % (v[0], v[1]) for v in styles.values()) + '.c99{color:#1155cc;text-decoration:underline}'
print('<html><head><meta content="text/html; charset=UTF-8"><style type="text/css">' + css + '</style></head><body class="c10 doc-content">' + ''.join(out) + '</body></html>')
