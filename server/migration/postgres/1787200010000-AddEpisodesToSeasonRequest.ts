import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEpisodesToSeasonRequest1787200010000 implements MigrationInterface {
  name = 'AddEpisodesToSeasonRequest1787200010000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "season_request" ADD "episodes" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "season_request" DROP COLUMN "episodes"`
    );
  }
}
