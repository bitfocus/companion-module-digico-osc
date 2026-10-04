import type { CommandRow } from './commandTable.js'

export type SelectorProvider = {
	key: string
	section: string
	countPath: string
	namePath: string
	maxCount: number
}

/** Build selector sources from the command paths that return item names. */
export function deriveSelectorProviders(rows: CommandRow[]): SelectorProvider[] {
	const namePaths = new Set(
		rows.map((row) => row.oscPath).filter((path) => path.includes('*') && path.endsWith('/name')),
	)

	return [...namePaths].flatMap((namePath) => {
		const section = namePath.split('/').filter(Boolean)[0]
		if (!section) return []
		return [
			{
				key: section.toLowerCase(),
				section,
				countPath: `/Console/${section}`,
				namePath,
				maxCount: 512,
			},
		]
	})
}

/** Resolve nested send selectors to the output section whose names they use. */
export function selectorProviderForSegment(
	segment: string | undefined,
	providers: SelectorProvider[],
): SelectorProvider | undefined {
	if (!segment) return undefined
	const section = segment.replace(/_Send$/i, '_Outputs')
	return providers.find((provider) => provider.key === section.toLowerCase())
}
