/* Copyright (c) 2021 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

export function toCIdentifier(name: string) {
    return name.toLowerCase().replace(/[@,-]/g, '_').replace(/[#&]/g, '');
}
