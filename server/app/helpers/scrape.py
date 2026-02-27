import logging
import os

logger = logging.getLogger(__name__)

def _build_firecrawl_app():
    api_key = (os.getenv("FIRECRAWL_API_KEY") or "").strip()
    if not api_key:
        return None

    from firecrawl import FirecrawlApp

    return FirecrawlApp(api_key=api_key)


def scrape_web_page(url: str) -> str:
    """
    Scrape the content of a web page using Firecrawl.

    Args:
        url (str): The URL of the web page to scrape.

    Returns:
        str: The scraped content of the web page.
    """
    try:
        firecrawl_app = _build_firecrawl_app()
        if firecrawl_app is None:
            raise ValueError("FIRECRAWL_API_KEY environment variable is not set.")

        response = firecrawl_app.scrape_url(url, formats=["markdown"])
        if not response.error and response.markdown:
            return response.markdown
        else:
            raise Exception(f"Failed to scrape {url}: {response.error}")
    except Exception as e:
        logger.error(f"Error scraping {url}: {str(e)}")
        raise Exception(f"Error scraping {url}: {str(e)}")
