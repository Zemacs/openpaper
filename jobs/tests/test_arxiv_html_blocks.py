import unittest

from src.web_extract.arxiv_html_blocks import extract_arxiv_structured_content


class ArxivHtmlBlocksTests(unittest.TestCase):
    def test_extract_structured_blocks_and_raw_content(self) -> None:
        html = """
        <html>
          <body>
            <article class="ltx_document">
              <h1 class="ltx_title">Sample Paper</h1>
              <div class="ltx_para">
                This paragraph describes the method in sufficient detail so that the extracted
                content passes minimum quality checks and remains readable in the article reader.
              </div>
              <table class="ltx_equation ltx_eqn_table">
                <tr><td><math alttext="x = y + z" display="block"></math></td></tr>
              </table>
              <ul>
                <li>First bullet point for analysis.</li>
                <li>Second bullet point for ablations.</li>
              </ul>
              <table class="ltx_tabular">
                <caption>Main benchmark table</caption>
                <thead>
                  <tr>
                    <th rowspan="2">Task Group</th>
                    <th colspan="2">Language Pair</th>
                    <th rowspan="2">Metric</th>
                  </tr>
                  <tr>
                    <th>Source</th>
                    <th>Target</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th rowspan="2" scope="row">Translation</th>
                    <td>EN</td>
                    <td>DE</td>
                    <td>BLEU 28.4</td>
                  </tr>
                  <tr>
                    <td>EN</td>
                    <td>FR</td>
                    <td>BLEU 31.2</td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr><td colspan="4">Note: test split only.</td></tr>
                </tfoot>
              </table>
              <figure class="ltx_figure">
                <img src="x1.png" />
                <figcaption>Overview diagram.</figcaption>
              </figure>
            </article>
          </body>
        </html>
        """
        result = extract_arxiv_structured_content(
            page_html=html,
            base_url="https://arxiv.org/html/1234.5678v1",
            max_chars=10000,
        )

        block_types = [str(block.get("type")) for block in result.blocks]
        self.assertIn("h1", block_types)
        self.assertIn("paragraph", block_types)
        self.assertIn("equation", block_types)
        self.assertIn("list", block_types)
        self.assertIn("table", block_types)
        self.assertIn("image", block_types)

        self.assertIn("x = y + z", result.raw_content)
        self.assertIn("Task Group | Language Pair | Metric", result.raw_content)
        self.assertGreaterEqual(int(result.block_counts.get("equation", 0)), 1)
        self.assertGreaterEqual(int(result.block_counts.get("table", 0)), 1)
        table_block = next(block for block in result.blocks if str(block.get("type")) == "table")
        self.assertEqual(table_block.get("caption"), "Main benchmark table")
        self.assertIn("notes", table_block)
        self.assertGreaterEqual(len(table_block.get("header_rows") or []), 1)
        self.assertGreaterEqual(len(table_block.get("body_rows") or []), 1)
        first_header_row = (table_block.get("header_rows") or [[]])[0]
        self.assertEqual(first_header_row[0].get("rowspan"), 2)
        self.assertEqual(first_header_row[1].get("colspan"), 2)

    def test_truncates_raw_content_to_max_chars(self) -> None:
        long_paragraph = " ".join(["transformer"] * 2000)
        html = f"""
        <html>
          <body>
            <article class="ltx_document">
              <div class="ltx_para">{long_paragraph}</div>
            </article>
          </body>
        </html>
        """
        result = extract_arxiv_structured_content(
            page_html=html,
            base_url="https://arxiv.org/html/1234.5678v1",
            max_chars=512,
        )
        self.assertLessEqual(len(result.raw_content), 512)

    def test_equation_inside_ltx_para_is_extracted_separately(self) -> None:
        html = """
        <html>
          <body>
            <article class="ltx_document">
              <div class="ltx_para">
                The following equation defines the optimization objective.
                <table class="ltx_equation ltx_eqn_table">
                  <tr>
                    <td><math alttext="L = E + R" display="block"><annotation encoding="application/x-tex">L = E + R</annotation></math></td>
                    <td><span class="ltx_tag_equation">(1)</span></td>
                  </tr>
                </table>
                Additional explanation after the equation.
              </div>
            </article>
          </body>
        </html>
        """
        result = extract_arxiv_structured_content(
            page_html=html,
            base_url="https://arxiv.org/html/1234.5678v1",
            max_chars=4000,
        )
        block_types = [str(block.get("type")) for block in result.blocks]
        self.assertIn("paragraph", block_types)
        self.assertIn("equation", block_types)
        self.assertIn("L = E + R", result.raw_content)
        equation_blocks = [block for block in result.blocks if block.get("type") == "equation"]
        self.assertGreaterEqual(len(equation_blocks), 1)
        self.assertEqual(str(equation_blocks[0].get("equation_tex")), "L = E + R")
        self.assertEqual(str(equation_blocks[0].get("equation_number")), "(1)")

    def test_relative_figure_assets_resolve_with_document_path(self) -> None:
        html = """
        <html>
          <body>
            <article class="ltx_document">
              <div class="ltx_para">
                This paragraph provides enough context to keep the extracted content readable
                while we verify that figure assets resolve relative to the arXiv HTML document path.
              </div>
              <figure class="ltx_figure">
                <img src="x1.png" />
                <figcaption>Overview diagram.</figcaption>
              </figure>
            </article>
          </body>
        </html>
        """
        result = extract_arxiv_structured_content(
            page_html=html,
            base_url="https://arxiv.org/html/2602.09024v1",
            max_chars=4000,
        )

        image_block = next(block for block in result.blocks if block.get("type") == "image")
        self.assertEqual(
            image_block.get("image_url"),
            "https://arxiv.org/html/2602.09024v1/x1.png",
        )

    def test_extracts_reference_items_with_clickable_arxiv_links(self) -> None:
        html = """
        <html>
          <body>
            <article class="ltx_document">
              <h2>References</h2>
              <ul class="ltx_biblist">
                <li class="ltx_bibitem ltx_bib_article">
                  <span class="ltx_tag">A. Author (2024)</span>
                  <span class="ltx_bibblock">A useful transformer paper.</span>
                  <span class="ltx_bibblock">arXiv preprint arXiv:2401.01234.</span>
                  <span class="ltx_bibblock ltx_bib_cited">Cited by: <a href="#S1">§1</a>.</span>
                </li>
              </ul>
            </article>
          </body>
        </html>
        """
        result = extract_arxiv_structured_content(
            page_html=html,
            base_url="https://arxiv.org/html/2602.09024v1",
            max_chars=4000,
        )

        reference_blocks = [block for block in result.blocks if block.get("type") == "reference"]
        self.assertEqual(len(reference_blocks), 1)
        reference_block = reference_blocks[0]
        self.assertIn("A useful transformer paper", str(reference_block.get("text")))
        links = reference_block.get("links") or []
        self.assertGreaterEqual(len(links), 1)
        self.assertEqual(links[0].get("href"), "https://arxiv.org/abs/2401.01234")
        self.assertEqual(links[0].get("label"), "arXiv:2401.01234")

    def test_reference_items_without_direct_identifiers_get_scholar_fallback(self) -> None:
        html = """
        <html>
          <body>
            <article class="ltx_document">
              <ul class="ltx_biblist">
                <li class="ltx_bibitem ltx_bib_inproceedings">
                  <span class="ltx_bibblock">Some conference paper without explicit DOI or arXiv id.</span>
                </li>
              </ul>
            </article>
          </body>
        </html>
        """
        result = extract_arxiv_structured_content(
            page_html=html,
            base_url="https://arxiv.org/html/2602.09024v1",
            max_chars=4000,
        )

        reference_block = next(block for block in result.blocks if block.get("type") == "reference")
        links = reference_block.get("links") or []
        self.assertEqual(len(links), 1)
        self.assertEqual(links[0].get("label"), "Scholar")
        self.assertIn("scholar.google.com/scholar?q=", str(links[0].get("href")))

    def test_paragraph_preserves_inline_links_and_math_without_duplicates(self) -> None:
        html = """
        <html>
          <body>
            <article class="ltx_document">
              <div class="ltx_para">
                <p class="ltx_p">
                  Scaling improves quality
                  <cite>(Author, <a class="ltx_ref" href="#bib.bib1">2024</a>; Second, <a class="ltx_ref" href="#bib.bib2">2025</a>)</cite>
                  while using <math alttext="2^{64}" display="inline"><annotation encoding="application/x-tex">2^{64}</annotation></math>
                  codes.
                </p>
              </div>
              <li class="ltx_bibitem" id="bib.bib1">Author (2024) Useful reference.</li>
              <li class="ltx_bibitem" id="bib.bib2">Second (2025) Another reference.</li>
            </article>
          </body>
        </html>
        """
        result = extract_arxiv_structured_content(
            page_html=html,
            base_url="https://arxiv.org/html/2602.09024v1",
            max_chars=4000,
        )

        paragraph_blocks = [block for block in result.blocks if block.get("type") == "paragraph"]
        self.assertEqual(len(paragraph_blocks), 1)
        paragraph_block = paragraph_blocks[0]
        self.assertEqual(
            paragraph_block.get("text"),
            "Scaling improves quality (Author, 2024; Second, 2025) while using 2^{64} codes.",
        )
        self.assertEqual(
            paragraph_block.get("inline_markdown"),
            "Scaling improves quality ([Author, 2024](<#article-ref-bib-bib1>); [Second, 2025](<#article-ref-bib-bib2>)) while using $2^{64}$ codes.",
        )
        inline_runs = paragraph_block.get("inline_runs") or []
        self.assertGreaterEqual(len(inline_runs), 3)
        link_runs = [run for run in inline_runs if run.get("type") == "link"]
        self.assertEqual(len(link_runs), 2)
        link_run = link_runs[0]
        self.assertEqual(link_run.get("href"), "#article-ref-bib-bib1")
        self.assertEqual(
            ((link_run.get("children") or [{}])[0]).get("text"),
            "Author, 2024",
        )
        self.assertEqual(link_runs[1].get("href"), "#article-ref-bib-bib2")
        math_run = next(run for run in inline_runs if run.get("type") == "math")
        self.assertEqual(math_run.get("text"), "2^{64}")
        reference_block = next(block for block in result.blocks if block.get("type") == "reference")
        self.assertEqual(reference_block.get("anchor_id"), "article-ref-bib-bib1")

    def test_paragraph_preserves_inline_emphasis_bold_and_code_runs(self) -> None:
        html = """
        <html>
          <body>
            <article class="ltx_document">
              <div class="ltx_para">
                We propose <em>masked Bit Autoregressive modeling</em> with
                <strong>BAR</strong> and a <tt>codebook</tt> representation
                for efficient image generation in H<sub>2</sub>O with x<sup>2</sup> scaling in this section.
              </div>
            </article>
          </body>
        </html>
        """
        result = extract_arxiv_structured_content(
            page_html=html,
            base_url="https://arxiv.org/html/2602.09024v1",
            max_chars=4000,
        )

        paragraph_block = next(block for block in result.blocks if block.get("type") == "paragraph")
        self.assertIn("masked Bit Autoregressive modeling", str(paragraph_block.get("text")))
        self.assertIn("*masked Bit Autoregressive modeling*", str(paragraph_block.get("inline_markdown")))
        self.assertIn("**BAR**", str(paragraph_block.get("inline_markdown")))
        self.assertIn("`codebook`", str(paragraph_block.get("inline_markdown")))
        self.assertIn("H2O", str(paragraph_block.get("text")))
        self.assertIn("x2 scaling", str(paragraph_block.get("text")))
        inline_runs = paragraph_block.get("inline_runs") or []
        run_types = [str(run.get("type")) for run in inline_runs]
        self.assertIn("em", run_types)
        self.assertIn("strong", run_types)
        self.assertIn("code", run_types)
        self.assertIn("sub", run_types)
        self.assertIn("sup", run_types)

    def test_paragraph_preserves_smallcaps_underline_and_strike_runs(self) -> None:
        html = """
        <html>
          <body>
            <article class="ltx_document">
              <div class="ltx_para">
                The <span class="ltx_font_smallcaps">Diffusion</span> pipeline uses
                <u>token masking</u> while <del>legacy decoding</del> is replaced
                in the final implementation for better readability.
              </div>
            </article>
          </body>
        </html>
        """
        result = extract_arxiv_structured_content(
            page_html=html,
            base_url="https://arxiv.org/html/2602.09024v1",
            max_chars=4000,
        )

        paragraph_block = next(block for block in result.blocks if block.get("type") == "paragraph")
        inline_runs = paragraph_block.get("inline_runs") or []
        run_types = [str(run.get("type")) for run in inline_runs]
        self.assertIn("smallcaps", run_types)
        self.assertIn("underline", run_types)
        self.assertIn("strike", run_types)
        self.assertIn("~~legacy decoding~~", str(paragraph_block.get("inline_markdown")))

    def test_extracts_span_based_arxiv_figure_tables(self) -> None:
        html = """
        <html>
          <body>
            <article class="ltx_document">
              <figure class="ltx_table" id="S4.T1">
                <figcaption>
                  Table 1: Scaling BAR-FSQ codebook size (
                  <math alttext="C"><annotation encoding="application/x-tex">C</annotation></math>
                  ) with different prediction heads.
                </figcaption>
                <span class="ltx_tabular">
                  <span class="ltx_thead">
                    <span class="ltx_tr">
                      <span class="ltx_td ltx_th ltx_th_column ltx_rowspan ltx_rowspan_2">bits</span>
                      <span class="ltx_td ltx_th ltx_th_column ltx_rowspan ltx_rowspan_2">C</span>
                      <span class="ltx_td ltx_th ltx_th_column ltx_colspan ltx_colspan_2">w/o CFG</span>
                    </span>
                    <span class="ltx_tr">
                      <span class="ltx_td ltx_th ltx_th_column">gFID</span>
                      <span class="ltx_td ltx_th ltx_th_column">IS</span>
                    </span>
                  </span>
                  <span class="ltx_tbody">
                    <span class="ltx_tr">
                      <span class="ltx_td ltx_rowspan ltx_rowspan_2">10</span>
                      <span class="ltx_td ltx_rowspan ltx_rowspan_2">1024</span>
                      <span class="ltx_td">2.80</span>
                      <span class="ltx_td">171.6</span>
                    </span>
                    <span class="ltx_tr">
                      <span class="ltx_td">1.73</span>
                      <span class="ltx_td">238.7</span>
                    </span>
                  </span>
                </span>
              </figure>
            </article>
          </body>
        </html>
        """
        result = extract_arxiv_structured_content(
            page_html=html,
            base_url="https://arxiv.org/html/2602.09024v1",
            max_chars=4000,
        )

        table_blocks = [block for block in result.blocks if block.get("type") == "table"]
        self.assertEqual(len(table_blocks), 1)
        self.assertNotIn("image", [str(block.get("type")) for block in result.blocks])
        table_block = table_blocks[0]
        self.assertEqual(
            table_block.get("caption"),
            "Table 1: Scaling BAR-FSQ codebook size (C) with different prediction heads.",
        )
        self.assertEqual(len(table_block.get("header_rows") or []), 2)
        self.assertEqual(len(table_block.get("body_rows") or []), 2)
        self.assertEqual((table_block.get("header_rows") or [[{}]])[0][0].get("rowspan"), 2)
        self.assertEqual((table_block.get("header_rows") or [[{}, {}]])[0][2].get("colspan"), 2)
        self.assertIn(
            "Table 1: Scaling BAR-FSQ codebook size (C) with different prediction heads.",
            result.raw_content,
        )

    def test_table_cells_preserve_inline_math_and_emphasis(self) -> None:
        html = """
        <html>
          <body>
            <article class="ltx_document">
              <table class="ltx_tabular">
                <thead>
                  <tr>
                    <th><strong>Metric</strong></th>
                    <th>Symbol</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><em>gFID</em></td>
                    <td><math alttext="\\downarrow"><annotation encoding="application/x-tex">\\downarrow</annotation></math></td>
                  </tr>
                </tbody>
              </table>
            </article>
          </body>
        </html>
        """
        result = extract_arxiv_structured_content(
            page_html=html,
            base_url="https://arxiv.org/html/2602.09024v1",
            max_chars=4000,
        )

        table_block = next(block for block in result.blocks if block.get("type") == "table")
        header_cell = ((table_block.get("header_rows") or [[]])[0])[0]
        body_metric_cell = ((table_block.get("body_rows") or [[]])[0])[0]
        body_symbol_cell = ((table_block.get("body_rows") or [[]])[0])[1]

        self.assertEqual(header_cell.get("inline_markdown"), "**Metric**")
        self.assertEqual((header_cell.get("inline_runs") or [{}])[0].get("type"), "strong")
        self.assertEqual(body_metric_cell.get("inline_markdown"), "*gFID*")
        self.assertEqual((body_metric_cell.get("inline_runs") or [{}])[0].get("type"), "em")
        self.assertEqual(body_symbol_cell.get("inline_markdown"), "$\\downarrow$")
        self.assertEqual((body_symbol_cell.get("inline_runs") or [{}])[0].get("type"), "math")


if __name__ == "__main__":
    unittest.main()
