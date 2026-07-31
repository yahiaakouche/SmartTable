import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { OrderChannel, OrderStatus } from '@smarttable/shared-types';

export class OrderItemInputDto {
  /** Shape validated here; existence + availability at the service (ES §6). */
  @IsUUID()
  productId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  notes?: string;
}

/** Staff manual order entry (POST /orders). */
export class CreateOrderDto {
  @IsUUID()
  tableId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items!: OrderItemInputDto[];
}

/** Customer QR submission (POST /public/orders) — carries the unguessable
 * token, never a raw tableId (Contract §3). 32 bytes base64url = 43 chars. */
export class PublicCreateOrderDto {
  @IsString()
  @Length(43, 43)
  qrToken!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items!: OrderItemInputDto[];
}

/** Add-on Order (POST /orders/:id/addon) — same bill group as the parent. */
export class CreateAddonOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items!: OrderItemInputDto[];
}

/** FR10 — mandatory reason (DB CHECK is the final backstop behind this). */
export class CancelOrderDto {
  @IsString()
  @Length(1, 500)
  reason!: string;
}

/** GET /orders — cursor pagination + the three frozen filters. */
export class ListOrdersQueryDto {
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @IsOptional()
  @IsUUID()
  tableId?: string;

  @IsOptional()
  @IsEnum(OrderChannel)
  channel?: OrderChannel;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
