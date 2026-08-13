import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIssueDeletionRequest1786583300000 implements MigrationInterface {
  name = 'AddIssueDeletionRequest1786583300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "issue" ADD COLUMN "deletionRequested" boolean NOT NULL DEFAULT (0)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "issue" DROP COLUMN "deletionRequested"`
    );
  }
}
