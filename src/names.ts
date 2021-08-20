export function toCIdentifier(name: string) {
    return name.toLowerCase().replace(/[@,-]/g, '_').replace(/[#&]/g, '');
}
