/**
 * MusicBrainz WS/2 JSON responses, validated at the boundary (CLAUDE.md code
 * conventions). Only fields Tagmonia reads are declared; unknown keys pass
 * through so a new MusicBrainz field never breaks a lookup.
 */
import { z } from "zod";

export const mbidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

const artistRef = z.looseObject({
  id: mbidSchema,
  name: z.string(),
  "sort-name": z.string().optional(),
});

export const artistCreditSchema = z.array(z.looseObject({
  name: z.string(),
  joinphrase: z.string().default(""),
  artist: artistRef,
}));

/** Work and relation schemas refer to each other (work → relations → work). */
export interface MbRelation {
  type: string;
  "type-id"?: string;
  direction?: string;
  "target-type": string;
  attributes: string[];
  "attribute-credits"?: Record<string, string>;
  "ordering-key"?: number;
  artist?: z.infer<typeof artistRef>;
  work?: MbWork;
  [k: string]: unknown;
}

export interface MbWork {
  id: string;
  title: string;
  relations?: MbRelation[];
  [k: string]: unknown;
}

export const relationSchema: z.ZodType<MbRelation> = z.lazy(() =>
  z.looseObject({
    type: z.string(),
    "type-id": z.string().optional(),
    direction: z.string().optional(),
    "target-type": z.string(),
    attributes: z.array(z.string()).default([]),
    "attribute-credits": z.record(z.string(), z.string()).optional(),
    "ordering-key": z.number().optional(),
    artist: artistRef.optional(),
    work: workSchema.optional(),
  })
);

export const workSchema: z.ZodType<MbWork> = z.lazy(() =>
  z.looseObject({
    id: mbidSchema,
    title: z.string(),
    relations: z.array(relationSchema).optional(),
  })
);

const recordingSchema = z.looseObject({
  id: mbidSchema,
  title: z.string(),
  length: z.number().nullable().optional(),
  isrcs: z.array(z.string()).optional(),
  "artist-credit": artistCreditSchema.optional(),
  relations: z.array(relationSchema).optional(),
});

const trackSchema = z.looseObject({
  id: mbidSchema,
  number: z.string(),
  position: z.number().int(),
  title: z.string(),
  length: z.number().nullable().optional(),
  "artist-credit": artistCreditSchema.optional(),
  recording: recordingSchema,
});

const mediumSchema = z.looseObject({
  position: z.number().int(),
  title: z.string().nullable().optional(),
  format: z.string().nullable().optional(),
  "track-count": z.number().int(),
  tracks: z.array(trackSchema).optional(),
});

const labelInfoSchema = z.looseObject({
  "catalog-number": z.string().nullable().optional(),
  label: z.looseObject({ id: mbidSchema, name: z.string() }).nullable().optional(),
});

const releaseGroupSchema = z.looseObject({
  id: mbidSchema,
  title: z.string().optional(),
  "primary-type": z.string().nullable().optional(),
  "secondary-types": z.array(z.string()).optional(),
  "first-release-date": z.string().optional(),
});

const releaseBase = {
  id: mbidSchema,
  title: z.string(),
  status: z.string().nullable().optional(),
  date: z.string().optional(),
  country: z.string().nullable().optional(),
  barcode: z.string().nullable().optional(),
  "artist-credit": artistCreditSchema.optional(),
  "label-info": z.array(labelInfoSchema).optional(),
  "release-group": releaseGroupSchema.optional(),
  "text-representation": z.looseObject({
    language: z.string().nullable().optional(),
    script: z.string().nullable().optional(),
  }).optional(),
};

export const releaseSchema = z.looseObject({
  ...releaseBase,
  media: z.array(mediumSchema).default([]),
  relations: z.array(relationSchema).optional(),
});

export const releaseSearchSchema = z.looseObject({
  count: z.number().int(),
  offset: z.number().int(),
  releases: z.array(z.looseObject({
    ...releaseBase,
    score: z.number(),
    "track-count": z.number().int().optional(),
    media: z.array(z.looseObject({
      format: z.string().nullable().optional(),
      "track-count": z.number().int(),
    })).default([]),
  })),
});

/** Browse of a release group's releases: no tracklists, but enough for the edition picker (D38). */
export const releaseBrowseSchema = z.looseObject({
  "release-count": z.number().int(),
  "release-offset": z.number().int(),
  releases: z.array(z.looseObject({
    ...releaseBase,
    media: z.array(z.looseObject({
      format: z.string().nullable().optional(),
      "track-count": z.number().int(),
    })).default([]),
  })),
});

export type MbArtistCredit = z.infer<typeof artistCreditSchema>;
export type MbRelease = z.infer<typeof releaseSchema>;
export type MbMedium = MbRelease["media"][number];
export type MbTrack = NonNullable<MbMedium["tracks"]>[number];
export type MbReleaseSearch = z.infer<typeof releaseSearchSchema>;
export type MbSearchRelease = MbReleaseSearch["releases"][number];
export type MbBrowseRelease = z.infer<typeof releaseBrowseSchema>["releases"][number];

const genreSchema = z.looseObject({ id: z.string(), name: z.string(), count: z.number().int().default(0) });

/** `release/<mbid>?inc=genres+release-groups`: the nested release group carries its own genres (D40). */
export const releaseGenresSchema = z.looseObject({
  id: mbidSchema,
  genres: z.array(genreSchema).default([]),
  "release-group": z.looseObject({ genres: z.array(genreSchema).default([]) }).optional(),
});

export type MbGenre = z.infer<typeof genreSchema>;
export type MbReleaseGenres = z.infer<typeof releaseGenresSchema>;
