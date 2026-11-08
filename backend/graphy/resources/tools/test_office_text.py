import io, os, subprocess, sys, tempfile, unittest, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, "office_text.py")
W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def zipbytes(files):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        for k, v in files:
            z.writestr(k, v)
    return b.getvalue()


def run(name, data):
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, name)
        with open(p, "wb") as f:
            f.write(data)
        r = subprocess.run([sys.executable, "-I", HELPER, p], capture_output=True)
        return r.returncode, r.stdout.decode(), r.stderr.decode()


class OfficeText(unittest.TestCase):
    def ok(self, name, data, *needles):
        code, out, err = run(name, data)
        self.assertEqual(code, 0, err)
        for n in needles:
            self.assertIn(n, out)
        return out

    def test_plain_cp1251_and_utf8(self):
        self.ok("a.txt", "Привет, мир".encode("cp1251"), "Привет, мир")
        self.ok("a.md", "# Заголовок".encode("utf-8"), "Заголовок")
        self.ok("a.csv", "a,b\n1,2".encode("utf-16"), "a,b")

    def test_html_cp1251(self):
        h = '<html><head><meta charset="windows-1251"><style>x{}</style></head><body><p>Квадратное уравнение</p><script>bad()</script></body></html>'
        out = self.ok("a.html", h.encode("cp1251"), "Квадратное уравнение")
        self.assertNotIn("bad()", out)

    def test_docx(self):
        doc = f'<w:document {W}><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Тема</w:t></w:r></w:p><w:p><w:r><w:t>Текст</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>x</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>y</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'
        self.ok("a.docx", zipbytes([("[Content_Types].xml", "<Types/>"), ("word/document.xml", doc)]), "# Тема", "Текст", "x\ty")

    def test_xlsx_truncation(self):
        rows = "".join(f'<row r="{i}"><c r="A{i}" t="s"><v>0</v></c><c r="C{i}"><v>{i}</v></c></row>' for i in range(1, 301))
        sheet = f'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{rows}</sheetData></worksheet>'
        wb = '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Оценки" sheetId="1" r:id="rId1"/></sheets></workbook>'
        rels = '<Relationships xmlns="x"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'
        ss = '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Имя</t></si></sst>'
        out = self.ok("a.xlsx", zipbytes([("[Content_Types].xml", "<Types/>"), ("xl/workbook.xml", wb), ("xl/_rels/workbook.xml.rels", rels), ("xl/sharedStrings.xml", ss), ("xl/worksheets/sheet1.xml", sheet)]), "Sheet: Оценки", "Имя\t\t1", "Truncated: showing first 200 of 300")
        self.assertNotIn("\t\t250", out)

    def test_pptx(self):
        a = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
        s = lambda t: f"<p {a}><a:p><a:r><a:t>{t}</a:t></a:r></a:p></p>"
        self.ok("a.pptx", zipbytes([("[Content_Types].xml", "<Types/>"), ("ppt/slides/slide2.xml", s("Второй")), ("ppt/slides/slide1.xml", s("Первый"))]), "## Slide 1\nПервый", "## Slide 2\nВторой")

    def test_odt_ods(self):
        ns = 'xmlns:office="o" xmlns:text="t" xmlns:table="b"'
        odt = f'<office:document-content {ns}><office:body><office:text><text:h>Глава</text:h><text:p>Абзац<text:s/>тут</text:p></office:text></office:body></office:document-content>'
        self.ok("a.odt", zipbytes([("mimetype", "application/vnd.oasis.opendocument.text"), ("content.xml", odt)]), "# Глава", "Абзац тут")
        ods = f'<office:document-content {ns}><office:body><office:spreadsheet><table:table table:name="T"><table:table-row><table:table-cell><text:p>a</text:p></table:table-cell><table:table-cell><text:p>b</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>'
        self.ok("a.ods", zipbytes([("mimetype", "application/vnd.oasis.opendocument.spreadsheet"), ("content.xml", ods)]), "a\tb")

    def test_epub_fb2_rtf(self):
        cont = '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/c.opf"/></rootfiles></container>'
        opf = '<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="a" href="ch1.xhtml"/></manifest><spine><itemref idref="a"/></spine></package>'
        self.ok("a.epub", zipbytes([("mimetype", "application/epub+zip"), ("META-INF/container.xml", cont), ("OEBPS/c.opf", opf), ("OEBPS/ch1.xhtml", "<html><body><p>Глава один</p></body></html>")]), "Глава один")
        fb = '<?xml version="1.0" encoding="windows-1251"?><FictionBook><description><title-info><book-title>Книга</book-title></title-info></description><body><section><title><p>Часть</p></title><p>Жили-были</p></section></body></FictionBook>'
        self.ok("a.fb2", fb.encode("cp1251"), "# Книга", "Часть", "Жили-были")
        self.ok("a.fb2.zip", zipbytes([("a.fb2", fb.encode("cp1251"))]), "Жили-были")
        r = r"{\rtf1\ansi\ansicpg1251{\fonttbl{\f0 Arial;}}\f0 \'cf\'f0\'e8\'e2\'e5\'f2\par \u1052?\u1080?\u1088? {\*\generator X;}end}"
        self.ok("a.rtf", r.encode("ascii"), "Привет", "Мир", "end")
        self.assertNotIn("Arial", run("a.rtf", r.encode("ascii"))[1])
        self.ok("b.rtf", rb"{\rtf1\ansicpg1251 \'cf\'f0 rtf}", "Пр rtf")

    def test_legacy_djvu_zip_binary_damaged(self):
        for name, data, word in (("a.doc", b"\xd0\xcf\x11\xe0" + b"0" * 50, "docx"), ("a.djvu", b"AT&TFORM....", "DjVu"), ("a.bin", b"\x00\x01\x02", "Binary")):
            code, _, err = run(name, data)
            self.assertEqual(code, 2)
            self.assertIn(word, err)
        code, out, _ = run("a.zip", zipbytes([("x.txt", "hi")]))
        self.assertEqual(code, 0)
        self.assertIn("x.txt", out)
        code, _, err = run("bad.docx", zipbytes([("[Content_Types].xml", "<Types/>"), ("word/document.xml", "<broken")]))
        self.assertEqual(code, 2)
        self.assertIn("damaged", err)


if __name__ == "__main__":
    unittest.main()
