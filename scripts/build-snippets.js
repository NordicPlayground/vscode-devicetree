const yaml = require('js-yaml');
const fs = require('fs');

function main() {
    const doc = yaml.load(fs.readFileSync('snippets.yml', 'utf8'));
    fs.writeFileSync('snippets.json', JSON.stringify(doc, null, 4));
    console.log('Written snippets.json');
}

main();
