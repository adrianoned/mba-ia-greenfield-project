import { IsNotEmpty, IsNumber, IsString } from 'class-validator';

export class InitiateUploadDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsNotEmpty()
  fileName: string;

  @IsString()
  @IsNotEmpty()
  contentType: string;

  @IsNumber()
  fileSize: number;
}
