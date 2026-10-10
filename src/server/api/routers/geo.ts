import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { listCities, listCountries, listStates } from "~/server/geo";

// Location master list for the country / state / city pickers. Public because
// the signup form uses it before the visitor has an account; it only exposes
// GeoNames reference data.
export const geoRouter = createTRPCRouter({
  countries: publicProcedure.query(() => listCountries()),

  states: publicProcedure
    .input(z.object({ country: z.string().length(2) }))
    .query(({ input }) => listStates(input.country)),

  cities: publicProcedure
    .input(
      z.object({
        country: z.string().length(2),
        // Omitted for a country that has no states.
        state: z.string().max(100).optional(),
      }),
    )
    .query(({ input }) => listCities(input.country, input.state ?? null)),
});
