import { fetchFromApi } from "@/lib/api"
import { MinimalJob, PdfUploadResponse } from "@/lib/schema"

/**
 * Fetches a PDF from a URL client-side and returns it as a File object.
 * Extracts filename from content-disposition header or URL path,
 * falling back to a random filename if needed.
 */
const fetchPdfAsFile = async (url: string): Promise<File> => {
    const response = await fetch(url, {
        method: 'GET',
    });

    if (!response.ok) throw new Error('Failed to fetch PDF');

    const contentDisposition = response.headers.get('content-disposition');
    const randomFilename = Math.random().toString(36).substring(2, 15) + '.pdf';
    let filename = randomFilename;

    if (contentDisposition && contentDisposition.includes('attachment')) {
        const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
        const matches = filenameRegex.exec(contentDisposition);
        if (matches != null && matches[1]) {
            filename = matches[1].replace(/['"]/g, '');
        }
    } else {
        const urlParts = url.split('/');
        const urlFilename = urlParts[urlParts.length - 1];
        if (urlFilename && urlFilename.toLowerCase().endsWith('.pdf')) {
            filename = urlFilename;
        }
    }

    const blob = await response.blob();
    return new File([blob], filename, { type: 'application/pdf' });
}

const inferUrlSourceType = (url: string): "pdf_url" | "web_url" => {
    try {
        const parsed = new URL(url);
        if (parsed.pathname.toLowerCase().endsWith(".pdf")) {
            return "pdf_url";
        }
    } catch {
        // Let the backend validate malformed URLs.
    }
    return "web_url";
}

/**
 * Uploads a single file, optionally associating it with a project.
 */
const uploadFile = async (file: File, projectId?: string): Promise<MinimalJob> => {
    const formData = new FormData()
    formData.append("file", file)

    const endpoint = projectId
        ? `/api/paper/upload?project_id=${projectId}`
        : "/api/paper/upload";

    const res: PdfUploadResponse = await fetchFromApi(endpoint, {
        method: "POST",
        body: formData,
    })
    return { jobId: res.job_id, fileName: file.name }
}

export const uploadFiles = async (files: File[]): Promise<MinimalJob[]> => {
    const newJobs: MinimalJob[] = []
    const errors: Error[] = []
    for (const file of files) {
        try {
            const job = await uploadFile(file)
            newJobs.push(job)
        } catch (error) {
            console.error("Failed to start upload for", file.name, error)
            errors.push(error instanceof Error ? error : new Error(String(error)))
        }
    }
    // If all uploads failed, throw the first error so the caller knows what went wrong
    if (newJobs.length === 0 && errors.length > 0) {
        throw errors[0]
    }
    return newJobs
}

export const uploadFromUrl = async (url: string, projectId?: string): Promise<MinimalJob> => {
    const body = {
        source_type: inferUrlSourceType(url),
        url,
        project_id: projectId,
    };

    const res = await fetchFromApi("/api/document/import", {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
            "Content-Type": "application/json",
        },
    }) as PdfUploadResponse & { job_id: string };
    const fileName = res.file_name || url
    return { jobId: res.job_id, fileName: fileName }
}

/**
 * Uploads a document from a URL, first attempting client-side fetch for better filename handling
 * when the URL points to a PDF,
 * then falling back to server-side fetch if that fails.
 */
export const uploadFromUrlWithFallback = async (url: string, projectId?: string): Promise<MinimalJob> => {
    if (inferUrlSourceType(url) === "web_url") {
        return uploadFromUrl(url, projectId);
    }

    try {
        const file = await fetchPdfAsFile(url);
        return await uploadFile(file, projectId);
    } catch (error) {
        console.log('Client-side fetch failed, trying server-side fetch...', error);
        return await uploadFromUrl(url, projectId);
    }
}

// Convenience alias for project uploads
export const uploadFromUrlWithFallbackForProject = (url: string, projectId: string): Promise<MinimalJob> => {
    return uploadFromUrlWithFallback(url, projectId);
}
