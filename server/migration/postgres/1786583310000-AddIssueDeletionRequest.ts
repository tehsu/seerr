import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIssueDeletionRequest1786583310000 implements MigrationInterface {
  name = 'AddIssueDeletionRequest1786583310000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "issue" ADD "deletionRequested" boolean NOT NULL DEFAULT false`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "issue" DROP COLUMN "deletionRequested"`
    );
  }
}
