import remarkGfm from 'remark-gfm'
import createMDX from '@next/mdx'

const isE2EHarness = process.env.NEXT_PUBLIC_ENABLE_E2E_HARNESS === 'true'

/** @type {import('next').NextConfig} */
const nextConfig = {
    // Avoid .next corruption when local dev server and Playwright webServer run concurrently.
    distDir: isE2EHarness ? '.next-e2e' : '.next',
    allowedDevOrigins: ['127.0.0.1', 'localhost'],
    // Configure `pageExtensions` to include markdown and MDX files
    pageExtensions: ['js', 'jsx', 'md', 'mdx', 'ts', 'tsx'],
    // Enable source maps in production for error tracking
    productionBrowserSourceMaps: true,
    // Transpile packages that import CSS from node_modules
    transpilePackages: ['react-pdf-highlighter-extended', 'pdfjs-dist'],
    // Add image remote patterns configuration
    images: {
        remotePatterns: [
            {
                protocol: 'https' as const,
                hostname: 'assets.khoj.dev',
                port: '',
                pathname: '/**',
            },
            {
                protocol: 'https' as const,
                hostname: 'openpaper.ai',
                port: '',
                pathname: '/**',
            },
            {
                protocol: 'https' as const,
                hostname: 'lh3.googleusercontent.com',
                port: '',
                pathname: '/**',
            }
        ],
    },
}

const withMDX = createMDX({
    // Add markdown plugins here, as desired
    options: {
        remarkPlugins: [remarkGfm],
    }
})

// Merge MDX config with Next.js config
export default withMDX(nextConfig)
