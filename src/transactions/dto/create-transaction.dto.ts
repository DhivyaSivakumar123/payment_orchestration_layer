import { IsInt, IsNotEmpty, IsOptional, IsPositive, IsString, Length } from 'class-validator';

export class CreateTransactionDto {
  @IsString()
  @IsOptional()
  idempotencyKey?: string;

  @IsString()
  @IsNotEmpty()
  merchantId: string;

  @IsInt()
  @IsPositive()
  amount: number; // smallest currency unit

  @IsString()
  @Length(3, 3)
  currency: string;
}
