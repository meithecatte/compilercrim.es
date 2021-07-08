var = 25
print('fn main() { match todo!() {')
for i in range(var):
    print('(' + ', '.join('true' if j == i else '_' for j in range(var)), ') => {}')
print('} }')
