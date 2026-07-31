import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { PermissionKey } from '@smarttable/shared-types';
import type { CategoryDto, ProductDto } from '@smarttable/shared-types';
import { MenuService } from './menu.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { CurrentEmployee, ActingEmployee } from '../auth/decorators/current-employee.decorator';

/**
 * Menu endpoints (API Contract Design §3). Thin translation layer only —
 * all rules live in MenuService (Engineering Standards §3). Permissions per
 * FR19 / PRD §11: viewing is open to all staff roles; every mutation is
 * Owner+Manager (`menu.manage`).
 */
@Controller()
export class MenuController {
  constructor(private readonly menuService: MenuService) {}

  @RequirePermission(PermissionKey.MENU_VIEW)
  @Get('categories')
  listCategories(): Promise<CategoryDto[]> {
    return this.menuService.listCategories();
  }

  @RequirePermission(PermissionKey.MENU_MANAGE)
  @Post('categories')
  createCategory(@Body() dto: CreateCategoryDto): Promise<CategoryDto> {
    return this.menuService.createCategory(dto);
  }

  @RequirePermission(PermissionKey.MENU_MANAGE)
  @Patch('categories/:id')
  updateCategory(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto): Promise<CategoryDto> {
    return this.menuService.updateCategory(id, dto);
  }

  /** Soft delete (Database Schema, Cross-Cutting Rule 5). */
  @RequirePermission(PermissionKey.MENU_MANAGE)
  @Delete('categories/:id')
  async removeCategory(@Param('id', ParseUUIDPipe) id: string): Promise<{ success: true }> {
    await this.menuService.removeCategory(id);
    return { success: true };
  }

  /** Offset pagination for this bounded resource (API Contract §1),
   * filterable by categoryId / isAvailable (Contract §3). */
  @RequirePermission(PermissionKey.MENU_VIEW)
  @Get('products')
  async listProducts(
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('pageSize', new ParseIntPipe({ optional: true })) pageSize = 50,
    @Query('categoryId', new ParseUUIDPipe({ optional: true })) categoryId?: string,
    @Query('isAvailable', new ParseBoolPipe({ optional: true })) isAvailable?: boolean,
  ) {
    const result = await this.menuService.listProducts({ categoryId, isAvailable }, page, pageSize);
    return { data: result.products, meta: { page, pageSize, total: result.total } };
  }

  /** Multipart create — optional `image` file part (Security §6 pipeline). */
  @RequirePermission(PermissionKey.MENU_MANAGE)
  @Post('products')
  @UseInterceptors(FileInterceptor('image'))
  createProduct(@Body() dto: CreateProductDto, @UploadedFile() image?: Express.Multer.File): Promise<ProductDto> {
    return this.menuService.createProduct(dto, image?.buffer);
  }

  @RequirePermission(PermissionKey.MENU_MANAGE)
  @Patch('products/:id')
  @UseInterceptors(FileInterceptor('image'))
  updateProduct(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
    @CurrentEmployee() actor: ActingEmployee,
    @UploadedFile() image?: Express.Multer.File,
  ): Promise<ProductDto> {
    return this.menuService.updateProduct(id, dto, image?.buffer, actor.id);
  }

  /** Hard delete — Snapshot-protected (ADR-012, Database Schema §4). */
  @RequirePermission(PermissionKey.MENU_MANAGE)
  @Delete('products/:id')
  async removeProduct(@Param('id', ParseUUIDPipe) id: string): Promise<{ success: true }> {
    await this.menuService.removeProduct(id);
    return { success: true };
  }
}
