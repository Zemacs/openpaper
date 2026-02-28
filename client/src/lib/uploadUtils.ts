import { fetchFromApi } from "@/lib/api"
import { MinimalJob, PdfUploadResponse } from "@/lib/schema"

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
        source_type: "auto_url",
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
 * Uploads a document from a URL.
 * Server decides whether to treat it as PDF or web article import.
 */
export const uploadFromUrlWithFallback = async (url: string, projectId?: string): Promise<MinimalJob> => {
    return uploadFromUrl(url, projectId);
}

// Convenience alias for project uploads
export const uploadFromUrlWithFallbackForProject = (url: string, projectId: string): Promise<MinimalJob> => {
    return uploadFromUrlWithFallback(url, projectId);
}
