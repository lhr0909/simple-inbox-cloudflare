import { createFileRoute, notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { Suspense, use } from 'react'

import { useFumadocsLoader, type SerializedPageTree } from 'fumadocs-core/source/client'
import defaultMdxComponents from 'fumadocs-ui/mdx'
import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page'

import { docs, source } from '#/lib/source'

type DocsPageDescriptor = Readonly<{
  description: string
  pageTree: SerializedPageTree
  path: string
  title: string
}>

const resolveDocsPage = createServerFn({ method: 'GET' })
  .validator((slugs: string[]) => slugs)
  .handler(async ({ data: slugs }) => {
    const page = source.getPage(slugs)
    if (page === undefined) throw notFound()

    return {
      description: page.data.description ?? 'Simple Inbox documentation.',
      pageTree: await source.serializePageTree(source.getPageTree()),
      path: page.path,
      title: page.data.title ?? 'Simple Inbox',
    } satisfies DocsPageDescriptor
  })

export const Route = createFileRoute('/docs/$')({
  component: DocumentationPage,
  head: ({ params }) => {
    const slugs = params._splat?.split('/').filter(Boolean) ?? []
    const page = source.getPage(slugs)
    const title = page?.data.title ?? 'Documentation'
    const description = page?.data.description ?? 'Simple Inbox documentation.'
    return {
      meta: [
        { title: `${title} | Simple Inbox` },
        { name: 'description', content: description },
      ],
    }
  },
  loader: async ({ params }) => {
    const slugs = params._splat?.split('/').filter(Boolean) ?? []
    const descriptor = (await resolveDocsPage({ data: slugs })) as DocsPageDescriptor
    const page = docs.getPage(descriptor.path)
    if (page === undefined) throw notFound()
    await page.preload()
    return descriptor
  },
})

function DocumentationPage() {
  const descriptor = useFumadocsLoader(Route.useLoaderData() as unknown as DocsPageDescriptor)

  return (
    <DocsLayout
      tree={descriptor.pageTree}
      nav={{ title: 'Simple Inbox', url: '/docs' }}
      links={[
        { text: 'Documentation', url: '/docs', active: 'nested-url' },
        { text: 'Open inbox', url: '/inbox', type: 'button' },
      ]}
    >
      <Suspense>
        <DocumentationContent
          description={descriptor.description}
          path={descriptor.path}
          title={descriptor.title}
        />
      </Suspense>
    </DocsLayout>
  )
}

function DocumentationContent({ description, path, title }: Omit<DocsPageDescriptor, 'pageTree'>) {
  const page = docs.getPage(path)
  if (page === undefined) throw notFound()

  const content = use(page.load())
  const MDX = page.body

  return (
    <DocsPage toc={content.toc}>
      <DocsTitle>{title}</DocsTitle>
      <DocsDescription>{description}</DocsDescription>
      <DocsBody>
        <MDX components={defaultMdxComponents} />
      </DocsBody>
    </DocsPage>
  )
}
