import { Injectable, Logger, Scope } from '@nestjs/common';
import { PrismaService } from '@/db/prisma/services/prisma.service';
import { PlanetSearchQueryDto } from '@/resources/planets/dto/PlanetSearchQueryDto';
import {
  PlanetListResponseDto,
  PlanetResponseDto,
} from '@/resources/planets/dto/PlanetListResponseDto';
import { SwApiResponseDto } from '@/resources/planets/dto/SwapiResponseDto';
import { Planet, Prisma } from '@prisma/client';
import axios from 'axios';

@Injectable({ scope: Scope.TRANSIENT })
export class PlanetsService {
  private SWAPI_BASE = process.env.SWAP_BASE ?? `https://swapi.dev/api`;
  private logger: Logger;

  constructor(private prismaService: PrismaService) {
    this.logger = new Logger(PlanetsService.name);
  }

  public async getPlanets(
    query: PlanetSearchQueryDto,
  ): Promise<PlanetListResponseDto> {
    const planetsResultPromise = this.prismaService.planet.findMany({
      where: {
        name: {
          contains: query.name,
        },
      },
      take: query.limit,
      skip: query.offset,
    });

    const totalCountPromise = this.prismaService.planet.count({
      where: {
        name: {
          contains: query.name,
        },
      },
    });

    const [results, total] = await Promise.all([
      planetsResultPromise,
      totalCountPromise,
    ]);

    return {
      total,
      results: results.map((planet) => new PlanetResponseDto(planet)),
    };
  }

  public async scrapNewPlanets(query: PlanetSearchQueryDto): Promise<void> {
    // Due to the pagination mechanism, if we get more than 10 results,
    // we need to make more requests, by doing this,
    // we can make the requests for new values
    // while concurrently saving the results we already have in the database
    let queryURL = `${this.SWAPI_BASE}/planets/?search=${query.name}`;
    let insertionsArray: Promise<void>[] = [];

    do {
      const swApiResponse = await axios
        .get(queryURL)
        .then((response) => response.data as SwApiResponseDto);

      insertionsArray = [
        ...insertionsArray,
        ...this.checkAndSaveSwApiResponse(swApiResponse),
      ];
      queryURL = swApiResponse.next;
    } while (queryURL !== null);

    await Promise.all(insertionsArray);
  }

  private checkAndSaveSwApiResponse(
    swApiResponse: SwApiResponseDto,
  ): Promise<void>[] {
    //Here we check if the planet already exists in the database
    // If it does not exist, we create it
    // I don't use the createMany because it's not supported by the SQLite driver
    // https://github.com/prisma/prisma/issues/11507#issuecomment-1025587202
    return swApiResponse.results.map(async (planet) => {
      const existingCount = await this.prismaService.planet.count({
        where: {
          name: {
            contains: planet.name,
          },
        },
      });

      if (existingCount === 0) {
        try {
          await this.prismaService.planet.create({
            data: {
              name: planet.name,
              ...(!isNaN(parseInt(planet.diameter)) && {
                diameter: parseInt(planet.diameter),
              }),
              gravity: planet.gravity,
              terrain: planet.terrain,
              createdAt: planet.created,
              updatedAt: planet.edited,
            } as unknown as Planet,
          });
        } catch (e: any) {
          // Simple error handling. We don't want to stop the process.
          // We could return the error to the user, or a 206 (partial content)
          // to communicate that some results were not saved.
          this.logger.error(
            `Error while saving planet ${planet.name} in the database: `,
            e.message,
          );
        }
      }
    });
  }

  public async getPlanet(id: number): Promise<Planet | null> {
    return this.prismaService.planet.findUnique({
      where: {
        id: id,
      },
    });
  }

  public async deletePlanet(id: number): Promise<Planet | null> {
    return this.prismaService.planet.delete({
      where: {
        id: id,
      },
    });
  }
}
